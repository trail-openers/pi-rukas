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
  changePanicsAreBaseFailures,
  panicCanExcuseChange,
  panicIsCapturedPrint,
  perTestVerdictsFor,
} from "../src/work-driver-verify-rust.ts";
import {
  CARGO_TARGET_SUMMARY,
  makeAssert,
  rustPanicHeader,
  rustPanicHeaderWithId,
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

  // #2372 round 1 — the join guard asks the SAME per-test reader the vetoes
  // ask, so a verdict line the fold makes visible is refused like any other:
  // a decorated `#[should_panic]` `ok` and a spaced doctest `FAILED` are
  // libtest's verdict lines for SOME test, and welding either onto a header
  // quotes a test the run reported differently — the #798/#1762 misdirection
  // class. Asked in the id-bearing spelling, the one a current cargo prints
  // and the reason the guard became reachable on production streams. The
  // header's own name (`worker-3`) carries no verdict line, so what is under
  // test is the JOIN refusal, not the veto.
  const idHeader = rustPanicHeaderWithId("worker-3", "src/lib.rs:20:13", 2271626);
  for (const verdict of [
    "test tests::cap - should panic ... ok",
    "test src/lib.rs - fast_path_ms (line 3) ... FAILED",
  ]) {
    const stream = `${idHeader}\n${verdict}`;
    assert(
      extractSpecificAssertion(stream, stream) === idHeader,
      `panic join: the verdict line ${JSON.stringify(verdict)} is never welded onto an id-bearing header (got ${JSON.stringify(extractSpecificAssertion(stream, stream))})`,
    );
  }
  // The refusals are of verdict-shaped lines, not of continuation lines: the
  // pair the ticket exists to quote still joins in the id-bearing spelling too.
  {
    const msg = "pool bound exceeded: 101ms over the 100 ms bound";
    const stream = `${idHeader}\n${msg}`;
    assert(
      extractSpecificAssertion(stream, stream) === `${idHeader} ${msg}`,
      `panic join: an id-bearing header's real message still joins (got ${JSON.stringify(extractSpecificAssertion(stream, stream))})`,
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

// ── 4. the ok-skip is NON-MONOTONE (#2341 review wave HIGH) ────────────────
// The skip drops a header from the asks — a PERMISSIVE decision — so it may
// not be answered by the monotone any-`ok`-wins verdict: a name the change run
// reports BOTH ways also failed, and skipping it silently excuses a real
// panic. Four lenses filed the same line independently; each pin below is a
// refusal whose mirror (the same bytes minus the hiding `ok`) excuses, so a
// reverted monotone skip reddens the refusal and deleting the skip reddens the
// capture control.
{
  const flakyHeader = rustPanicHeader("fl::t", "src/f.rs:1:1");
  const flakyBase = ["running 1 test", "test fl::t ... FAILED", flakyHeader].join("\n");
  // The HIGH itself: `a::t` prints `ok` (a sibling crate, or an earlier passing
  // phase) and `FAILED` (the change-added panic) in ONE run. The old monotone
  // skip saw the `ok`, dropped the header, and excused the regression.
  const siblingOk = [
    "running 2 tests",
    "test a::t ... ok",
    "test a::t ... FAILED",
    rustPanicHeader("a::t", "src/r.rs:9:9"),
    "assertion failed: the check the change added",
  ].join("\n");
  assert(
    changePanicsAreBaseFailures("", siblingOk, "test a::t ... FAILED") === false,
    "ok-skip non-monotone: a change-added panic whose name a SIBLING CRATE reports ok beside the FAILED is refused, not skipped",
  );
  assert(
    changePanicsAreBaseFailures("", siblingOk.replace("test a::t ... ok\n", ""), "test a::t ... FAILED") ===
      true,
    "ok-skip mirror: the same panic excuses once the hiding sibling `ok` is gone — the refusal is the ok-beside-FAILED, not the name",
  );
  // Order must not matter for the skip: both permutations refuse.
  const okThenFailed = "test o::t ... ok\ntest o::t ... FAILED\n" + rustPanicHeader("o::t", "src/o.rs:1:1");
  const failedThenOk = "test o::t ... FAILED\ntest o::t ... ok\n" + rustPanicHeader("o::t", "src/o.rs:1:1");
  assert(
    changePanicsAreBaseFailures("", okThenFailed, "test o::t ... FAILED") === false,
    "ok-skip non-monotone (ok then FAILED): the later FAILED still bars the skip",
  );
  assert(
    changePanicsAreBaseFailures("", failedThenOk, "test o::t ... FAILED") === false,
    "ok-skip non-monotone (FAILED then ok): order-invariant — the ok never un-fails the name for the skip",
  );
  // The legitimate `#[should_panic]` capture still excuses: `cap` is reported
  // `ok` and NEVER `FAILED`, so its header is skipped; the flaky `fl::t` is
  // `FAILED` in both runs and excuses. Deleting the skip reddens this arm —
  // asked, the capture has no base verdict and would refuse the flaky's excuse.
  const captureRun = [
    "running 2 tests",
    "test cap::prints ... ok",
    "test fl::t ... FAILED",
    rustPanicHeader("cap::prints", "src/c.rs:3:3"),
    "captured print of a passing should_panic test",
    flakyHeader,
    "assertion failed: already broken at base",
  ].join("\n");
  assert(
    changePanicsAreBaseFailures(captureRun, captureRun, flakyBase) === true,
    "ok-skip control: the genuine should_panic capture (ok, never FAILED) is still skipped and the flaky test still excuses",
  );
  // The retried-phase flaky: the SAME name prints `FAILED` and then an `ok`
  // (a retried phase / second target). The non-monotone skip no longer applies,
  // both asks run, and the monotone CHANGE-side ask answers `ok` — so this
  // over-refuses. Named and pinned: the cost is one loud round for a test that
  // genuinely failed here, never a silent excuse for one that did not.
  const retried = [
    "running 1 test",
    "test fl::t ... FAILED",
    "running 1 test",
    "test fl::t ... ok",
    flakyHeader,
    "assertion failed: already broken at base",
  ].join("\n");
  assert(
    changePanicsAreBaseFailures(retried, retried, flakyBase) === false,
    "ok-skip accepted cost: a flaky whose retried phase prints ok AND FAILED for its own name now REFUSES (loud, one round) — the monotone change-side ask says ok; pinned deliberately",
  );
  assert(
    changePanicsAreBaseFailures(
      retried.replace("running 1 test\ntest fl::t ... ok\n", ""),
      retried.replace("running 1 test\ntest fl::t ... ok\n", ""),
      flakyBase,
    ) === true,
    "ok-skip accepted cost mirror: the single-phase flaky (FAILED only) still excuses — the refusal above is the retried ok, not the flaky",
  );

  // The non-monotone probe against the monotone observables, over the shape
  // table: the indexed view must answer the SAME questions the per-scan
  // predicates do (memoisation changes no answer), and a `Map` must make
  // `__proto__`/`constructor` and regex-metacharacter names ordinary keys.
  const shapes: Array<{ name: string; lines: string[]; ok: boolean; failed: boolean }> = [
    { name: "s::ok", lines: ["test s::ok ... ok"], ok: true, failed: false },
    { name: "s::failed", lines: ["test s::failed ... FAILED"], ok: false, failed: true },
    {
      name: "s::both-ok-first",
      lines: ["test s::both-ok-first ... ok", "test s::both-ok-first ... FAILED"],
      ok: true,
      failed: true,
    },
    {
      name: "s::both-failed-first",
      lines: ["test s::both-failed-first ... FAILED", "test s::both-failed-first ... ok"],
      ok: true,
      failed: true,
    },
    { name: "s::unreported", lines: ["test someone-else ... ok"], ok: false, failed: false },
    {
      name: "__proto__",
      lines: ["test __proto__ ... FAILED", "test __proto__ ... ok", "test constructor ... ok"],
      ok: true,
      failed: true,
    },
    {
      name: "meta::weird(+)?[x.*]",
      lines: ["test meta::weird(+)?[x.*] ... ok"],
      ok: true,
      failed: false,
    },
  ];
  for (const shape of shapes) {
    const stream = ["running 1 test", ...shape.lines, "test result: FAILED. 0 passed"].join("\n");
    const verdicts = perTestVerdictsFor(stream, shape.name);
    assert(
      verdicts.ok === shape.ok && verdicts.failed === shape.failed,
      `probe table ${JSON.stringify(shape.name)}: the non-monotone view reports exactly the verdicts printed (got ${JSON.stringify(verdicts)})`,
    );
    // Same evidence, same answers as the untouched monotone predicates.
    assert(
      panicIsCapturedPrint(stream, shape.name) === verdicts.ok,
      `probe table ${JSON.stringify(shape.name)}: monotone quote veto === any-ok`,
    );
    assert(
      panicCanExcuseChange(stream, rustPanicHeader(shape.name, "src/s.rs:1:1")) ===
        (verdicts.failed && !verdicts.ok),
      `probe table ${JSON.stringify(shape.name)}: monotone excuse ask === failed-and-never-ok`,
    );
  }
}

console.log(
  failed()
    ? "RUST PANIC PUBLISH/EXCUSE CHECKS FAILED"
    : "All Rust panic publish/excuse checks passed.",
);
process.exit(failed() ? 1 : 0);
