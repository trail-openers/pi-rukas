#!/usr/bin/env bun
/**
 * #723 — extractAttributedTail must anchor evidence on the sub-command that
 * actually failed, not on a fixed byte offset from the end of combined
 * stdout+stderr. A multi-stage verify-cmd chain (typecheck && biome &&
 * smoke-test loop) shares one output stream; a passing stage's own output
 * can be long enough to push a later failing stage's evidence outside a
 * naive `.slice(-N)` window.
 */

import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import { baselineExplainsChange } from "../src/work-driver-verify-baseline.ts";
import {
  RUST_CARGO_STREAM,
  RUST_SHOULD_PANIC_TRAP_AFTER_STREAM,
  RUST_TRAP_PAIR,
  RUST_VERDICT_OUTSIDE_WINDOW_STREAM,
  rustPanicHeader,
} from "./lib/verify-failure-shapes-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. The exact misattribution shape from #723: a passing `bun run check`
// biome banner (long, clean) followed by the FAILED marker, then the real
// verify-cmd shape (`echo "FAILED: $t"; bun "$t"` — the full verbose test
// re-run, unsuppressed) where the actual assertion detail is near the END
// of that re-run's output, not immediately after the marker line.
{
  const biomeBanner = "Checked 239 files in 66ms. No fixes applied.\n";
  const verboseSetup = "setting up test fixtures...\n".repeat(60); // >1500 chars
  const realFailureDetail =
    "✗ check on scaffolded file: exit 0 (got 1)\n✗ check: zero findings (got 1)\n";
  const combined = `${biomeBanner}FAILED: smoke-tests/test-agents-md-scaffold.ts\n${verboseSetup}${realFailureDetail}`;
  const { tail, attributed } = extractAttributedTail(combined, 1500);
  assert(
    tail.includes("check on scaffolded file: exit 0"),
    "combined multi-stage output: tail contains the real failure line",
  );
  assert(
    tail.startsWith("FAILED:"),
    "combined multi-stage output: tail is anchored on the FAILED marker, not the end of the stream",
  );
  assert(attributed, "combined multi-stage output: attributed is true when a marker is found");
}

// 2. A recognised diagnostic line on its OWN line anchors the tail (#1762): a
// single-command failure arrives as `${stdout}\n${stderr}`, so the harness hands the
// extractor a separate line, and the table recognises it. Attribution that used to be
// lost is now recovered — the pre-#723 blind slice stands only for a stream with no
// failure line at all (case 10).
{
  const combined = `${"a".repeat(2000)}\nerror[E0308]: mismatched types --> src/foo.rs:42`;
  const { tail, attributed } = extractAttributedTail(combined, 40);
  assert(tail.includes("E0308"), "anchored diagnostic: the tail contains the real error");
  assert(tail.length <= 40, "anchored diagnostic: tail respects maxLen");
  assert(
    attributed === true,
    "anchored diagnostic (#1762): a recognised diagnostic line on its own line anchors the tail",
  );
}

// 2b. The same diagnostic with NO line boundary before it: a 2000-char run directly
// followed by the diagnostic is ONE line whose head is noise. The classifier keeps
// `error[` out of the harness-wrapper vocabulary (a bracketed rustc code following a
// real `: ` is exactly the shape a gate's own path carries), so this stream is
// recognised as nothing and the blind slice — `attributed: false` — is the honest
// answer: evidence that claims attribution it does not have is the #723 defect.
{
  const combined = `${"a".repeat(2000)}error E0308 mismatched types --> src/foo.rs:42`;
  const { tail, attributed } = extractAttributedTail(combined, 1500);
  assert(tail.length <= 1500, "separator-less: tail respects maxLen");
  assert(
    attributed === false,
    "separator-less: a diagnostic welded to the end of a long noise run, with no line boundary, anchors nothing",
  );
}

// 2c. A recognised line that is ITSELF longer than the window (#1762): a wrapped
// one-line diagnostic — the shape the verify wrapper prints when a sub-command fails
// — is one line, so its head carries the recognisable marker even when the line
// cannot fit. De-attributing here threw away attribution the driver had earned; the
// tail is now the anchor start clipped to maxLen, and `attributed` stays true.
{
  const cmd = "bash -c 'exit 1'";
  const wrapped =
    `verify command \`${cmd}\` failed in /repo/.worktrees/issue-1-a: FAILED: 16 test(s) — ` +
    "extension/smoke-tests/test-".repeat(28) +
    "test-c.ts" +
    "x".repeat(25);
  assert(
    wrapped.length === 883 && wrapped.length > 800,
    `wrapped anchor line is longer than the window (${wrapped.length})`,
  );
  const { tail, attributed } = extractAttributedTail(wrapped, 800);
  assert(
    attributed === true,
    "wrapped anchor: a recognised line wider than the window keeps its attribution",
  );
  assert(tail.length <= 800, "wrapped anchor: tail respects maxLen");
  assert(
    tail.startsWith("verify command") || tail.startsWith("FAILED:"),
    `wrapped anchor: the tail starts at the anchor, not at the stream end (got ${JSON.stringify(tail.slice(0, 40))})`,
  );
}

// 3. Empty input → empty tail, no crash.
{
  const empty = extractAttributedTail("", 1500);
  assert(empty.tail === "" && empty.attributed === false, "empty input: empty unattributed tail");
  const whitespace = extractAttributedTail("   \n  ", 1500);
  assert(
    whitespace.tail === "" && whitespace.attributed === false,
    "whitespace-only input: empty unattributed tail",
  );
}

// 3b. #2341 — the cargo dialect, with the decisive pair EARLIER in the stream
// than the anchor candidates: a long passing prefix, then the panic pair, then
// cargo's trailing target summary. With only the summary recognised, the old
// last-recognition anchor started the tail AT that trailing line and sliced
// the panic off before the extractor ever saw it — the "recognition gap, not a
// truncation gap" inference was wrong. The panic header (namesTest) must win
// the anchor, and a blind end-of-stream slice must not be what remains.
{
  const passing = "test a::tests::passing_case_ok ... ok\n".repeat(90); // >2 KiB
  const combined = `${passing}${RUST_CARGO_STREAM}\n`;
  const { tail, attributed } = extractAttributedTail(combined, 1500);
  assert(attributed, "cargo anchor (#2341): the stream is attributed");
  assert(
    tail.startsWith("thread '"),
    `cargo anchor (#2341): anchored on the panic header, not the trailing summary or a blind slice (got: ${JSON.stringify(tail.slice(0, 40))})`,
  );
  assert(
    tail.includes("panicked at src/session/fastpath_tests.rs:91:5") &&
      tail.includes("fast path took 101.409582ms"),
    "cargo anchor (#2341): the panic pair survives the 1500-char window",
  );
  assert(
    !tail.startsWith("error: test failed"),
    "cargo anchor (#2341): the target-level summary never owns the anchor",
  );
  assert(tail.length <= 1500, "cargo anchor (#2341): tail respects maxLen");
}

// 3c. #2341 — several panics in one target: the anchor is the LAST recognised
// named line (the accepted last-occurrence rule, unchanged for the new shape),
// so the LAST panic's pair is what survives — and the first panic's summary
// half cannot de-anchor the region.
{
  const first =
    "thread 'a::first_test' panicked at src/a.rs:1:1:\nfirst measured 12ms over the 10ms bound\n";
  const second =
    "thread 'b::second_test' panicked at src/b.rs:2:2:\nsecond measured 33ms over the 30ms bound\n";
  const combined = `${first}note: run with \`RUST_BACKTRACE=1\`\n\n${second}error: test failed, to rerun pass \`--bin nessie\``;
  const { tail } = extractAttributedTail(combined, 1500);
  assert(
    tail.startsWith("thread 'b::second_test'"),
    `cargo anchor (#2341): the LAST panic wins the anchor, not the summary (got: ${JSON.stringify(tail.slice(0, 40))})`,
  );
}

// 3d. #2341 fix wave (H1) — the anchor walk asks the SAME name-correlated
// should_panic veto the extractor asks: when the CAPTURED panic of a passing
// `#[should_panic]` test sits LAST in the stream, anchoring on it (the old
// last-named rule) sliced the genuinely-failing test's pair off before the
// extractor ever saw it. The header whose own test the window reports as
// `... ok` is not a named anchor; the window starts at the failing test's
// panic and its pair survives end to end.
{
  const { tail } = extractAttributedTail(RUST_SHOULD_PANIC_TRAP_AFTER_STREAM, 1500);
  assert(
    tail.startsWith("thread 'b::slow_path"),
    `cargo anchor (#2341 H1): the captured panic of a passing test does not own the anchor (got: ${JSON.stringify(tail.slice(0, 40))})`,
  );
  assert(
    extractSpecificAssertion(tail) === RUST_TRAP_PAIR,
    `cargo anchor (#2341 H1): the failing test's pair survives the window (got: ${JSON.stringify(extractSpecificAssertion(tail))})`,
  );
}

// 3e. #2341 fix wave 4 (H1/H2) — the per-test verdict of the captured name is
// visible ONLY OUTSIDE the 1500-char window: the elision cut lands between the
// panic header and its own `test a::t ... ok` line, so a veto asked on the
// window alone sees no verdict and lets the capture own the anchor and become
// the assertion. The anchor walk now asks the shared predicate on the very
// window it is about to produce AND on the whole stream, and a header whose
// test any observed verdict line reports as passing is refused at BOTH tiers —
// not named, not even a last-resort anchor. The control below keeps the veto
// name-correlated rather than a ban: with no verdict for the name anywhere,
// nothing was observed and the header still anchors.
{
  const { tail, attributed } = extractAttributedTail(RUST_VERDICT_OUTSIDE_WINDOW_STREAM, 1500);
  assert(
    !tail.startsWith("thread '"),
    `cargo anchor (#2341 H1/H2): the captured panic does not own the anchor even though its ok line is outside the window (got: ${JSON.stringify(tail.slice(0, 40))})`,
  );
  assert(
    extractSpecificAssertion(tail) === NO_SPECIFIC_ASSERTION,
    `cargo anchor (#2341 H1/H2): the captured panic never becomes the assertion (got: ${JSON.stringify(extractSpecificAssertion(tail).slice(0, 60))})`,
  );
  const unobserved = extractAttributedTail(
    RUST_VERDICT_OUTSIDE_WINDOW_STREAM.replace("test a::t ... ok\n", ""),
    1500,
  );
  assert(
    unobserved.attributed && unobserved.tail.startsWith("thread '"),
    "cargo anchor (#2341 H1/H2): an unobserved verdict vetoes nothing — the header still anchors when no verdict line exists",
  );
}

// 3f. #2341 fix wave 4 (MEDIUM) — the extractor's OWN `...` elision marker
// must never be joined as the panic message: `extractAttributedTail` builds
// over-long windows as `anchorLine + "\n...\n" + tail`, so when the clip
// lands directly under a panic header, `...` is the line beneath it and the
// join site must refuse it and prefer the header (which still names test,
// file and line).
{
  const pad = Array.from({ length: 60 }, (_, n) => `crate dep_${n} downloaded and compiled`).join("\n");
  const stream =
    `${pad}\ntest a::t ... FAILED\n${rustPanicHeader("a::t", "src/a.rs:7:5")}\n` +
    Array.from({ length: 80 }, (_, n) => `warning: unused import ${n}`).join("\n") +
    "\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out";
  const { tail } = extractAttributedTail(stream, 1500);
  assert(
    tail.startsWith(rustPanicHeader("a::t", "src/a.rs:7:5")) && tail.includes("\n...\n"),
    `elision join (#2341): the window really is the anchored cut with the marker beneath the header (got ${JSON.stringify(tail.slice(0, 60))})`,
  );
  assert(
    extractSpecificAssertion(tail) === rustPanicHeader("a::t", "src/a.rs:7:5"),
    `elision join (#2341): the '...' cut line is never joined as the panic message (got ${JSON.stringify(extractSpecificAssertion(tail))})`,
  );
}

// 3g. #2341 fix wave 5 (H1/H2) — the window the anchor walk PUBLISHES is the
// window the veto was asked on. When the `FAILED:` marker owns the anchor the
// published region starts at the MARKER, not at the candidate the veto examined,
// and on a long stream the elision cut away the `test a::t ... ok` line that
// proves the panic below it is a passing `#[should_panic]` test's captured
// print. The extractor then found no per-test verdict in what it was handed,
// fell through to the target tally the window DID keep, answered "verdict
// observed, not vetoed", and quoted the PASSING test as "the assertion at
// base" — which `baselineExplainsChange` then used to EXCUSE the panic the
// change added. The publisher now carries the stream's own verdict line into
// the window it hands over, so the one veto the extractor asks is decidable on
// the bytes it receives.
//
// This stream is NOT free of other anchor candidates: the `FAILED:` marker and
// the panic header are both recognised lines, and the marker is what wins the
// anchor — so going green here says the published window is sound, not that the
// walk had nothing else to choose from.
{
  const compile = Array.from(
    { length: 45 },
    (_, n) => `   Compiling crate_${n} v0.1.0 (registry)`,
  ).join("\n");
  // `combinedExecFailureStream` orders a stage's stdout (the verdict lines)
  // before its stderr (the panic prints), which is what puts `a::t`'s `ok`
  // ABOVE the panic print that belongs to it.
  const stream = [
    "FAILED: smoke-tests/test-rust-unit.ts",
    "running 4 tests",
    "test a::t ... ok",
    "test a::one ... ok",
    "test a::two ... ok",
    compile,
    "thread 'a::t' panicked at src/a.rs:7:5:",
    "assertion failed: elapsed < 100ms",
    "test a::slow ... FAILED",
    "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s",
  ].join("\n");
  const { tail } = extractAttributedTail(stream, 1500);
  assert(
    tail.includes("test a::t ... ok"),
    `capture in the published window (#2341 H1/H2): the verdict that decides the veto is in the bytes handed over (got ${JSON.stringify(tail.slice(0, 60))})`,
  );
  assert(
    extractSpecificAssertion(tail) === NO_SPECIFIC_ASSERTION,
    `capture in the published window (#2341 H1/H2): the passing test's panic never becomes the assertion (got: ${JSON.stringify(extractSpecificAssertion(tail).slice(0, 70))})`,
  );
  // The same window against the change's own failure: the capture prints
  // byte-identically in both runs, so the folded base assertion excused the
  // panic the change added.
  const base = extractSpecificAssertion(tail);
  const verdict = {
    status: "red" as const,
    rawStream: stream,
    probed: true,
    exitCode: 101,
    assertion: base === NO_SPECIFIC_ASSERTION ? null : base,
  };
  const changeFailure = [
    "FAILED: smoke-tests/test-rust-unit.ts",
    "thread 'a::t' panicked at src/a.rs:7:5:",
    "assertion failed: elapsed < 100ms",
    "test a::slow ... FAILED",
    "thread 'b::new' panicked at src/b.rs:2:2:",
    "assertion failed: the check the change added",
  ].join("\n");
  assert(
    baselineExplainsChange(verdict, [{ text: changeFailure, timedOut: false }]) === false,
    "capture in the published window (#2341 H1/H2): the change-added failure is NOT excused",
  );
}

// 3h. #2341 fix wave 5 (over-refusal) — the whole-stream ask is NAME-CORRELATED
// ONLY. The chain shape this module's own header describes: stage 1 is a GREEN
// `cargo test` (its target tally says `3 passed; 0 failed`) and a LATER stage's
// binary dies. There is no `test main ... ok` line anywhere, so nothing was
// observed about `main` — and the earlier stage's aggregate tally must not
// answer for it. Wave 4 let it, vetoed at both tiers, and silently restored
// #1762's unactionable generic handoff for the common case.
{
  const greenStage = [
    "running 3 tests",
    "test a::one ... ok",
    "test a::two ... ok",
    "test a::three ... ok",
    "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s",
    ...Array.from({ length: 30 }, (_, n) => `   Compiling later_crate_${n} v0.1.0`),
  ].join("\n");
  const binaryDied =
    "thread 'main' panicked at src/main.rs:12:5:\nsmoke check failed: expected 200 got 500 from /health";
  const { tail, attributed } = extractAttributedTail(`${greenStage}\n${binaryDied}`, 1500);
  assert(
    attributed,
    "chain stage (#2341 wave 5): a green earlier stage does not de-anchor the later stage's real panic",
  );
  assert(
    extractSpecificAssertion(tail) ===
      "thread 'main' panicked at src/main.rs:12:5: smoke check failed: expected 200 got 500 from /health",
    `chain stage (#2341 wave 5): the binary's panic is still quoted with its message (got ${JSON.stringify(extractSpecificAssertion(tail).slice(0, 70))})`,
  );
  // The control: when the stream DOES hold a per-test verdict for the name,
  // the name-correlated veto still fires — the fix is not the absence of one.
  const reported = `${greenStage}\ntest main ... ok\n${binaryDied}`;
  assert(
    extractSpecificAssertion(extractAttributedTail(reported, 1500).tail) === NO_SPECIFIC_ASSERTION,
    "chain stage (#2341 wave 5): a per-test ok for the panic's own name still vetoes it",
  );
}

// 4. Multiple FAILED markers (a shape this doesn't currently produce, but a
// future verify-cmd revision might) — anchors on the LAST one. This also
// pins the accepted-limitation behaviour documented in the module jsdoc:
// the anchor is deliberately "last occurrence", not "the real verify-cmd
// marker specifically" — a test whose own output prints a `FAILED:` line
// can shift the anchor, and that tradeoff is intentional.
{
  const combined =
    "FAILED: smoke-tests/test-a.ts\nsome earlier detail\n" +
    "FAILED: smoke-tests/test-b.ts\nthe real last failure detail";
  const { tail, attributed } = extractAttributedTail(combined, 1500);
  assert(
    tail.startsWith("FAILED: smoke-tests/test-b.ts"),
    "multiple markers: anchors on the LAST FAILED marker (pinned, accepted limitation)",
  );
  assert(tail.includes("the real last failure detail"), "multiple markers: last failure's detail present");
  assert(attributed, "multiple markers: still attributed since a marker was found");
}

// 5. The anchored tail is still bounded — a verbose re-run after FAILED can
// itself be very long; the size cap must still apply, just measured from
// the marker rather than from the end of the stream. When the anchored
// region is truncated, BOTH the marker line (attribution) and the tail of
// the anchored region (where the real diagnosis lives) must survive — a
// head-only truncation would keep the marker but discard exactly the
// content that explains the failure, reintroducing a milder form of the
// bug this module fixes.
{
  const combined = `FAILED: smoke-tests/test-huge.ts\n${"y".repeat(5000)}`;
  const { tail, attributed } = extractAttributedTail(combined, 1500);
  assert(tail.length <= 1500, "anchored tail still respects maxLen");
  assert(tail.startsWith("FAILED:"), "anchored tail starts at the marker even when bounded");
  assert(attributed, "anchored tail: attributed is true");
  assert(
    tail.endsWith("y"),
    "anchored tail: retains content from the END of the anchored region, not just the head",
  );
}

// 6. Realistic shape: marker line, then long verbose framework/setup noise,
// then the actual assertion failure at the very end. A head-truncating
// implementation keeps the marker plus setup noise and discards the
// assertion — exactly the information an operator needs. The tail must
// contain the real diagnosis.
{
  const setupNoise = "setting up test fixtures...\n".repeat(80); // well over 1500 chars
  const realAssertionFailure =
    "AssertionError: expected 200 to equal 404\n" +
    "  at Object.<anonymous> (smoke-tests/test-real.ts:42:11)\n" +
    "  stack trace continues...";
  const combined = `FAILED: smoke-tests/test-real.ts\n${setupNoise}${realAssertionFailure}`;
  const { tail, attributed } = extractAttributedTail(combined, 1500);
  assert(attributed, "realistic shape: attributed is true");
  assert(tail.startsWith("FAILED: smoke-tests/test-real.ts"), "realistic shape: marker line retained");
  assert(
    tail.includes("expected 200 to equal 404"),
    "realistic shape: the real assertion failure text survives truncation",
  );
  assert(tail.length <= 1500, "realistic shape: tail respects maxLen");
}

// 7. #827 new-tail-shape (fix (a)): the smoke loop repeats each failing test's
// bounded `✗` lines AFTER the final summary line. The `✗` lines now sit
// inside the 800-char window (last-anchored), so the tail contains the real
// assertion. Pre-fix, the `✗` lines were thousands of chars before the
// summary and the 800-char tail was summary-only (the #772 defect).
{
  const verboseOutput = "setting up test fixtures...\n".repeat(100); // ~3.4KB, well over 800
  const realAssertion =
    "✗ extension/smoke-tests/test-loop-detector.ts: 667 lines (exceeds 500-line hard limit)";
  const summaryLine =
    "FAILED: 1 test(s) — extension/smoke-tests/test-file-size-limit.ts";
  // Post-fix shape: per-test detail first, then the summary, then the
  // repeated bounded `✗` lines (the fix repeats them under/after the summary).
  const combined = `FAILED: extension/smoke-tests/test-file-size-limit.ts\n${verboseOutput}${realAssertion}\n${summaryLine}\n${realAssertion}`;
  const { tail, attributed } = extractAttributedTail(combined, 800);
  assert(tail.length <= 800, "new-tail-shape: tail respects the 800-char bound");
  assert(attributed, "new-tail-shape: attributed is true when a marker is found");
  assert(
    tail.includes("667 lines (exceeds 500-line hard limit)"),
    "new-tail-shape: the real ✗ assertion is IN the 800-char tail (post-fix, not elided)",
  );
  assert(
    tail.includes("test-file-size-limit.ts"),
    "new-tail-shape: the summary's failing file name is in the tail",
  );
}

// 8. #827 new-tail-shape, multi-failure: two tests fail, the fix repeats each
// test's bounded `✗` lines after the summary. The 800-char tail contains the
// first `✗` assertion AND the summary listing both files. The 800-char bound
// is preserved (the repeated lines are bounded to first 3 per test).
{
  const verbose1 = "alpha setup noise...\n".repeat(50); // ~1.1KB
  const verbose2 = "beta setup noise...\n".repeat(50); // ~1.1KB
  const assertion1 = "✗ alpha assertion: expected 0 got 2";
  const assertion2 = "✗ beta assertion: expected 1 got 9";
  const summaryLine =
    "FAILED: 2 test(s) — extension/smoke-tests/test-alpha.ts, extension/smoke-tests/test-beta.ts";
  // Post-fix: per-test details first, summary, then repeated bounded ✗ lines.
  const combined = `FAILED: extension/smoke-tests/test-alpha.ts\n${verbose1}${assertion1}\nFAILED: extension/smoke-tests/test-beta.ts\n${verbose2}${assertion2}\n${summaryLine}\n${assertion1}\n${assertion2}`;
  const { tail, attributed } = extractAttributedTail(combined, 800);
  assert(tail.length <= 800, "new-tail-shape multi-failure: tail respects the 800-char bound");
  assert(attributed, "new-tail-shape multi-failure: attributed is true");
  assert(
    tail.includes("alpha assertion: expected 0 got 2"),
    "new-tail-shape multi-failure: the first ✗ assertion is in the tail",
  );
  assert(
    tail.includes("test-alpha.ts") && tail.includes("test-beta.ts"),
    "new-tail-shape multi-failure: the summary lists BOTH failing files in the tail",
  );
}

// 9. #827 new-tail-shape, 800-char bound preservation: even with the repeated
// `✗` lines added, the tail must not exceed 800 chars. The summary name list
// is capped to 780 chars to fit the 800-char budget; the repeated `✗` lines
// replace some of the verbose per-test output that would otherwise be
// elided. The total (marker + elision + end-of-region) must stay ≤ 800.
{
  const verboseOutput = "x".repeat(5000); // 5KB of noise
  const realAssertion = "✗ real assertion: some failure detail";
  const summaryLine = "FAILED: 1 test(s) — smoke-tests/test-foo.ts";
  const combined = `FAILED: smoke-tests/test-foo.ts\n${verboseOutput}${realAssertion}\n${summaryLine}\n${realAssertion}`;
  const { tail } = extractAttributedTail(combined, 800);
  assert(tail.length <= 800, "800-char bound: tail never exceeds maxLen even with repeated ✗ lines");
  assert(tail.startsWith("FAILED:"), "800-char bound: tail still anchored on the last marker");
}

// 10. #827 new-tail-shape, and #1762: a stream with NO failure line at all —
// every line is noise or a passing tally — still gets the pre-#723 blind slice,
// unattributed. The 5KB of `a`s here carries no recognised shape, which is what
// keeps the fallback observable.
{
  const combined = `${"a".repeat(2000)} cases, 0 failed`;
  const { tail, attributed } = extractAttributedTail(combined, 800);
  assert(tail.length <= 800, "no-failure-line: fallback respects maxLen");
  assert(attributed === false, "no-failure-line: attributed is false");
}

console.log(exit === 0 ? "\nAll exec-error attribution checks passed." : "\nFAILED");
process.exit(exit);
