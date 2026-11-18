#!/usr/bin/env bun
/**
 * #2341 fix wave — what a Rust panic may PUBLISH, and what may EXCUSE.
 *
 * The three files that used to own these pins are at the §12 line cap, so they
 * live here:
 *
 *   - the PAIR the extractor publishes. `joinedRustPanic` is the one place the
 *     reader publishes a line it never judged: the continuation beneath a panic
 *     header goes into the published pair, and from there into a corrective-round
 *     prompt, a handoff and a forge comment. So it passes the screens the header
 *     itself passes — a continuation the credential screen still reads as key
 *     material is refused, and so is the extractor's own elision marker; the
 *     header alone stands (it still names the test, file and line);
 *   - ONE recognizer for both panic gates. The quote veto asked the table's
 *     shape key and the excuse gate its own line-anchored look, so a header the
 *     gate printed with a prefix (`error:`, `warning:`, a timestamp, `[INFO]`,
 *     an ANSI colour) was neither vetoed nor gated: quotable AND excusing.
 *
 * Falsifiable both ways: every refusal is asserted beside its mirror — the same
 * bytes with a genuinely failing verdict quote AND excuse — so a gate re-spelled
 * away reddens one arm or the other, and an ordinary continuation still joins.
 */

import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-verify-assertion.ts";
import { baselineExplainsChange } from "../src/work-driver-verify-baseline.ts";
import { makeAssert, rustPanicHeader } from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

// ── 1. the published panic pair: only lines the reader itself would publish ──
{
  const header = rustPanicHeader("a::t", "src/a.rs:7:5");
  const verdictLine = "test a::t ... FAILED";
  const ask = (tail: string): string => extractSpecificAssertion(tail, tail);

  // HIGH 1 — a continuation line that still reads as credential material after
  // the redactor had its turn is not the panic's message: the header alone is
  // published, so no secret reaches the handoff or the forge comment.
  const SECRET_BODY = `Zm9vYmFyYmF6cXV1eGNvcmdl${"4x7K"}`;
  const published = ask(`${verdictLine}\n${header}\ncompared token ${SECRET_BODY} in the fixture`);
  assert(
    published === header,
    `panic join: a credential-shaped continuation is not joined into the published assertion (got ${JSON.stringify(published)})`,
  );
  assert(
    !published.includes(SECRET_BODY),
    `panic join: and no part of the secret reaches the published field (${JSON.stringify(published)})`,
  );
  // The arm is credential-shaped, not a ban on continuation lines: the nessie
  // pair the ticket exists to quote still joins.
  assert(
    ask(
      `${verdictLine}\n${header}\nfast path took 101.409582ms, which is over the 100 ms bound`,
    ) === `${header} fast path took 101.409582ms, which is over the 100 ms bound`,
    "panic join: an ordinary message still joins — the screen is the only new refusal",
  );

  // HIGH 1 (carried row) — the extractor's OWN elision marker is a cut, never
  // the panic's message. The two spellings are the refusal; the whitespace arm
  // pins the same "wherever a caller stops trimming" rule the `\S+::` arm beside
  // it already carries (this extractor trims, so it is defence in depth there).
  for (const elision of ["...", "\u2026", "   ...   "]) {
    assert(
      ask(`${verdictLine}\n${header}\n${elision}`) === header,
      `panic join: the elision marker ${JSON.stringify(elision)} is never joined (the header alone still names the test)`,
    );
  }
}

// ── 2. one recognizer for the quote and the excuse ──────────────────────────
{
  const prefixedQuote = "error: thread 'v::t' panicked at src/v.rs:1:1: captured print";
  const passing = ["test v::t ... ok", prefixedQuote].join("\n");
  assert(
    extractSpecificAssertion(passing, passing) === NO_SPECIFIC_ASSERTION,
    `prefixed panic: a header the gate prefixed is refused as a QUOTE when its own test passed (got ${JSON.stringify(extractSpecificAssertion(passing, passing))})`,
  );
  for (const prefix of ["", "warning: ", "2026-01-01T00:00:00.000Z ", "[INFO] ", "\u001b[31m"]) {
    const line = `${prefix}thread 'v::t' panicked at src/v.rs:1:1:`;
    assert(
      baselineExplainsChange(
        { status: "red", rawStream: passing, probed: true, exitCode: 101, assertion: line },
        [{ text: line, timedOut: false }],
      ) === false,
      `prefixed panic (${JSON.stringify(prefix)}): and the same header never EXCUSES a change failure`,
    );
  }
  // The recognizer is name-correlated, not a ban on prefixed panics: the same
  // prefixed header whose own test the run reported FAILED quotes, and excuses.
  const failingV = ["test v::t ... FAILED", prefixedQuote].join("\n");
  const quoted = extractSpecificAssertion(failingV, failingV);
  assert(
    quoted === prefixedQuote,
    `prefixed panic control: with its own FAILED verdict the prefixed header still quotes (got ${JSON.stringify(quoted)})`,
  );
  assert(
    baselineExplainsChange(
      {
        status: "red",
        rawStream: failingV,
        probed: true,
        exitCode: 101,
        assertion: quoted,
      },
      [{ text: failingV, timedOut: false }],
    ) === true,
    "prefixed panic control: and it still excuses — the gate is evidence, not a prefix ban",
  );
}

console.log(
  failed()
    ? "RUST PANIC PUBLISH/EXCUSE CHECKS FAILED"
    : "All Rust panic publish/excuse checks passed.",
);
process.exit(failed() ? 1 : 0);
