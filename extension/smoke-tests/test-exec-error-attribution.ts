#!/usr/bin/env bun
/**
 * #723 — extractAttributedTail must anchor evidence on the sub-command that
 * actually failed, not on a fixed byte offset from the end of combined
 * stdout+stderr. A multi-stage verify-cmd chain (typecheck && biome &&
 * smoke-test loop) shares one output stream; a passing stage's own output
 * can be long enough to push a later failing stage's evidence outside a
 * naive `.slice(-N)` window.
 */

import { extractAttributedTail } from "../src/work-driver-exec-error.ts";

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

// 2. No FAILED marker present (a single-command failure, e.g. tsc or a
// direct execFn rejection) — falls back to the last maxLen chars, the
// pre-#723 behaviour, but now flagged as unattributed rather than silently.
{
  const combined = `${"a".repeat(2000)}error[E0308]: mismatched types --> src/foo.rs:42`;
  const { tail, attributed } = extractAttributedTail(combined, 1500);
  assert(tail.includes("E0308"), "no marker: falls back to tail slice, contains the real error");
  assert(tail.length <= 1500, "no marker: fallback tail respects maxLen");
  assert(attributed === false, "no marker: attributed is false so the fallback is observable");
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

// 10. #827 new-tail-shape, no-marker chain-stage failure unchanged: tsc/biome
// failures emit no FAILED marker and hit the attributed:false fallback. The
// fix does not alter this path — the fallback still returns the last maxLen
// chars, unattributed.
{
  const combined = `${"a".repeat(2000)}error[E0308]: mismatched types --> src/foo.rs:42`;
  const { tail, attributed } = extractAttributedTail(combined, 800);
  assert(tail.includes("E0308"), "no-marker unchanged: fallback contains the real error");
  assert(tail.length <= 800, "no-marker unchanged: fallback respects maxLen");
  assert(attributed === false, "no-marker unchanged: attributed is false");
}

console.log(exit === 0 ? "\nAll exec-error attribution checks passed." : "\nFAILED");
process.exit(exit);
