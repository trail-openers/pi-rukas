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
 *     an ANSI colour) was neither vetoed nor gated: quotable AND excusing;
 *   - the excuse is decided PER FAILING TEST of the change's record, and the
 *     change side pays the name-correlated question the base side already paid —
 *     of the run, never of the clipped record. The headers it enumerates come from
 *     the run too (#2370): the same clip that hides a verdict line hides a second
 *     panic's HEADER, and a header nothing asked about excuses nothing — while a
 *     header the run reports `ok` is a `#[should_panic]` capture and is skipped,
 *     never asked.
 *
 * Falsifiability: every refusal here is a `=== false` / `=== NO_SPECIFIC_ASSERTION`
 * claim whose mirror is asserted beside it (the same bytes with a genuinely
 * failing verdict quote AND excuse), so a gate re-spelled away reddens one arm or
 * the other. `panicCanExcuseChange` neutered reddens the excuse arms; the
 * extractor's join arms redden on their own.
 */

import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-verify-assertion.ts";
import { baselineExplainsChange } from "../src/work-driver-verify-baseline-compare.ts";
import {
  CARGO_TARGET_SUMMARY,
  makeAssert,
  rustPanicHeader,
} from "./lib/verify-failure-shapes-fixtures.ts";

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

// ── 3. the excuse is per failing test, and the change side pays it ──────────
{
  const baseFlaky = "base::flaky";
  const baseStream = [
    "running 2 tests",
    `test ${baseFlaky} ... FAILED`,
    rustPanicHeader(baseFlaky, "src/f.rs:1:1"),
    "assertion failed: already broken at base",
    "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured",
  ].join("\n");
  const baseAssertion = extractSpecificAssertion(baseStream, baseStream);
  const verdict = {
    status: "red" as const,
    rawStream: baseStream,
    probed: true,
    exitCode: 101,
    assertion: baseAssertion,
  };
  assert(
    baseAssertion.startsWith("thread 'base::flaky' panicked at src/f.rs:1:1:"),
    `aggregated record: the base's own panic is the assertion at base (${JSON.stringify(baseAssertion.slice(0, 48))})`,
  );
  const added = [
    rustPanicHeader("new::regression", "src/r.rs:9:9"),
    "assertion failed: the check the change added",
    "test new::regression ... FAILED",
  ].join("\n");
  assert(
    baselineExplainsChange(verdict, [{ text: baseStream, raw: baseStream, timedOut: false }]) ===
      true,
    "aggregated record control: a genuinely flaky test FAILED at base and again after the change still excuses",
  );
  assert(
    baselineExplainsChange(verdict, [
      { text: `${baseStream}\n${added}`, raw: `${baseStream}\n${added}`, timedOut: false },
    ]) === false,
    "aggregated record: the base's panic no longer excuses a DIFFERENT panic the change added to the same record",
  );
  // The change side pays the question the base side pays: a record that QUOTES
  // the base-failing panic, from a run that never reported that name failing,
  // is not evidence that the change's failures are the base's.
  const quotedOnly = `verify command \`cargo test\` failed in /wt: ${baseAssertion}`;
  assert(
    baselineExplainsChange(verdict, [
      {
        text: quotedOnly,
        raw: "running 0 tests\ntest result: ok. 0 passed; 0 failed",
        timedOut: false,
      },
    ]) === false,
    "change side pays: a record quoting a panic its own run never reported FAILED does not excuse",
  );
  // …and it is asked of the RUN, never of the clipped record: a record whose
  // elision sits above the failing name's verdict line excuses only once the
  // publishers thread that run alongside it.
  const clippedRecord = `verify command \`cargo test\` failed in /wt: ${baseAssertion}`;
  assert(
    baselineExplainsChange(verdict, [{ text: clippedRecord, timedOut: false }]) === false,
    "clipped record: asked to speak for its own stream, the clipped tail refuses (the loud direction)",
  );
  assert(
    baselineExplainsChange(verdict, [{ text: clippedRecord, raw: baseStream, timedOut: false }]) ===
      true,
    "clipped record: with the run threaded, the same flaky test excuses again",
  );

  // #2370 scoped pass — the clipping that hides a name's VERDICT LINE hides a
  // second panic's HEADER with it, and a header the record never carried was never
  // asked: the change-added regression rode in on the known flaky's excuse. Built
  // through the repo's OWN windower at the 800 chars `formatExecError` publishes —
  // a hand-written short string would not exercise the elision, and the arm would
  // be theatre.
  const cap = "cap::prints";
  const regressionHeader = rustPanicHeader("new::regression", "src/r.rs:9:9");
  const flakyHeader = rustPanicHeader(baseFlaky, "src/f.rs:1:1");
  const captureHeader = rustPanicHeader(cap, "src/c.rs:3:3");
  const changeLines: string[] = ["running 63 tests", "test new::regression ... FAILED"];
  for (let i = 0; i < 30; i++) changeLines.push(`test suite::pass_${i} ... ok`);
  changeLines.push(`test ${cap} ... ok`);
  for (let i = 30; i < 61; i++) changeLines.push(`test suite::pass_${i} ... ok`);
  changeLines.push(`test ${baseFlaky} ... FAILED`, "", "failures:", "");
  // The regression panics ABOVE the known flaky, so the windower's last-failure
  // anchor sits on the flaky's header and everything above it is the elision's.
  changeLines.push(
    "---- new::regression stdout ----",
    regressionHeader,
    "assertion failed: the check this change added",
    "",
  );
  // A `#[should_panic]` captured print: the header's byte-identical shape, from a
  // test libtest reports `ok` — the enumeration over the whole run has to see it.
  changeLines.push(
    `---- ${cap} stdout ----`,
    captureHeader,
    "captured print of a passing should_panic test",
    "",
  );
  changeLines.push(
    `---- ${baseFlaky} stdout ----`,
    flakyHeader,
    "assertion failed: already broken at base",
  );
  // The long diff beneath the flaky's own assertion is what pushes the anchored
  // region past the bound, i.e. what makes the published record a CLIP.
  for (let i = 0; i < 22; i++) {
    changeLines.push(`  left \`line ${i}: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\``);
  }
  changeLines.push(
    "",
    "failures:",
    `    ${baseFlaky}`,
    "    new::regression",
    "",
    "test result: FAILED. 61 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s",
    "",
    CARGO_TARGET_SUMMARY,
  );
  const changeRun = changeLines.join("\n");
  const published = (run: string): string =>
    `verify command \`cargo test\` failed in /wt/one: ${extractAttributedTail(run, 800).tail}`;
  const record = published(changeRun);
  assert(
    record.includes(flakyHeader) &&
      !record.includes(regressionHeader) &&
      record.includes("\n...\n"),
    `clipped enumeration fixture: the published record IS the windower's 800-char clip — flaky header kept, regression header elided, marker present (${record.length} chars)`,
  );
  assert(
    baselineExplainsChange(verdict, [{ text: record, raw: changeRun, timedOut: false }]) === false,
    "clipped enumeration: a change-added panic the record's elision hid does not excuse — the headers come from the run the verdict question already trusts",
  );
  // The mirror arm: the SAME flaky test, FAILED at base and again in this run, with
  // the `should_panic` capture still in the run it is enumerated from. It excuses
  // only because a header whose own test the change run reports `ok` is skipped
  // (the base prints no verdict line for a test that passes there) — delete that
  // skip and this arm reddens on the capture.
  const flakyRun = changeLines
    .filter((l) => !l.includes("new::regression") && !l.includes("src/r.rs:9:9"))
    .join("\n");
  assert(
    baselineExplainsChange(verdict, [
      { text: published(flakyRun), raw: flakyRun, timedOut: false },
    ]) === true,
    "clipped enumeration control: the genuinely flaky test still excuses with a should_panic capture in the run — the ok-skip is load-bearing, not decoration",
  );
}

console.log(
  failed()
    ? "RUST PANIC PUBLISH/EXCUSE CHECKS FAILED"
    : "All Rust panic publish/excuse checks passed.",
);
process.exit(failed() ? 1 : 0);
