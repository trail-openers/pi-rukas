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

console.log(exit === 0 ? "\nAll exec-error attribution checks passed." : "\nFAILED");
process.exit(exit);
