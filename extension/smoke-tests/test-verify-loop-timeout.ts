#!/usr/bin/env bun
/**
 * Issue #1014 — verify-loop: per-test timeout watchdog.
 *
 * The companion to test-verify-loop.ts (cases 1-8 live there). These two
 * cases run the same loop (smoke-tests/lib/verify-loop.sh) with a low
 * PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S override so the timeout path is
 * exercised in seconds instead of the 300s default.
 *
 * Cases:
 *   9.  #1014 timeout: a hanging fixture (low override) prints the marker
 *       + ✗ line + partial output, is counted in the summary, the loop exits
 *       non-zero, remaining tests still run, the fixture ran exactly once,
 *       no orphan survives, and the timeout-only pipeline yields
 *       attributed: true with the timeout line as the assertion.
 *   10. #1014 timeout-only pipeline: a single hanging fixture through the
 *       full consumer path (loop → tail → assertion) yields attributed:
 *       true and the `✗ timed out after <N>s` line as the specific
 *       assertion.
 *   11. #1014 exit-124 disambiguation: a test that exits 124 itself is a plain
 *       failure, not a timeout.
 *   12. #1365 exit-214 disambiguation: the watchdog's old return code is now an
 *       ordinary exit code a test may use, and a test that returns it is still
 *       not a timeout.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import { runLoopEnv } from "./verify-loop-lib.ts";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(__dirname, "fixtures", "verify-loop");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// #1014 — full consumer path (loop → tail → assertion) with an env override.
function pipelineEnv(
  files: string[],
  env: Record<string, string>,
): { tail: string; attributed: boolean; assertion: string } {
  const { stdout } = runLoopEnv(files, env);
  const { tail, attributed } = extractAttributedTail(stdout, 800);
  return { tail, attributed, assertion: extractSpecificAssertion(tail) };
}

// Shared env for the two timeout cases: PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S=2
// (the poll loop is 1s-resolution, the kill's grace is a bounded poll with a
// 20 × 0.1s = 2s ceiling → each ~2-3s, not the 300s default) plus a run-unique
// FIXTURE_HANG_TOKEN — the fixture bakes it into a `sleep` child's command line
// so the no-orphan check can find the descendant by pattern after the kill (the
// pid is not reliable: ps output can elide args, and the watchdog does not
// expose the child's pid).
//
// The 2s above is the CEILING of that poll, not its cost: the kill now polls
// for liveness to clear (same shape as the interrupt handler) instead of
// sleeping a fixed `sleep 2`, so a tree that dies immediately returns in well
// under a second and a case measures ~2-3s rather than 4-5s.
//
// The bound is pinned here rather than left to the default because the hang
// fixture sizes its child's sleep from PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: the
// env var is what makes the descendant outlive the watchdog instead of drifting
// to a lifetime the case never chose.
function hangTestEnv(caseId: string): { env: Record<string, string>; token: string } {
  const token = `hang-${caseId}-${process.pid}-${Date.now()}`;
  return { env: { PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: "2", FIXTURE_HANG_TOKEN: token }, token };
}

// --- Case 9: timeout reporting + continue-after-timeout. A hanging fixture
// first, then two more — the timed-out test is marked + counted + named, the
// remaining tests still run, the run stays bounded, and the hung fixture ran
// exactly once (counter file).
{
  const t0 = Date.now();
  const { env, token } = hangTestEnv("c9");
  const counterFile = path.join(tmpdir(), `verify-loop-hang-counter-${process.pid}`);
  rmSync(counterFile, { force: true });
  try {
    const { status, stdout } = runLoopEnv(
      [
        path.join(FIXTURES, "fixture-hang-counter.ts"),
        path.join(FIXTURES, "fixture-1.ts"),
        path.join(FIXTURES, "allpass-a.ts"),
      ],
      { ...env, FIXTURE_COUNTER_FILE: counterFile },
    );
    const elapsed = (Date.now() - t0) / 1000;
    const lines = stdout.trim().split("\n");

    // (a) timeout reported
    assert(status !== 0, "case 9: exit non-zero when a test times out");
    assert(
      stdout.includes("fixture-hang-counter.ts (timed out after 2s)"),
      "case 9: per-test marker names the file + (timed out after 2s)",
    );
    assert(
      stdout.includes("✗ timed out after 2s"),
      "case 9: the ✗ timed out after <N>s line is present",
    );
    assert(
      stdout.includes("fixture-hang-counter: starting, will hang until killed"),
      "case 9: the timed-out test's partial output is printed",
    );
    // (b) remaining tests still run
    assert(
      stdout.includes("fixture-1: assertion failed: expected 200, got 404"),
      "case 9: the remaining failing fixture still ran and reported",
    );
    assert(stdout.includes("allpass-a: ok"), "case 9: the remaining passing fixture still ran");
    // summary counts + names
    const summaryLines = lines.filter((l) => l.startsWith("FAILED: ") && l.includes("test(s)"));
    const summaryLine = summaryLines[summaryLines.length - 1];
    assert(
      summaryLine?.startsWith("FAILED: 2 test(s) —"),
      `case 9: the summary counts the two failures (timeout + fixture-1) (got: ${JSON.stringify(summaryLine)})`,
    );
    assert(
      (summaryLine ?? "").includes("fixture-hang-counter.ts") &&
        (summaryLine ?? "").includes("fixture-1.ts"),
      "case 9: the summary names the timed-out and the other failing fixture",
    );
    assert(
      !(summaryLine ?? "").includes("allpass-a.ts"),
      "case 9: the summary does not name the passing fixture",
    );
    // wall-clock bound
    assert(
      elapsed <= 12,
      `case 9: the run stays bounded despite the hang (${elapsed.toFixed(1)}s <= 12s)`,
    );
    // (c) exactly-once
    const invocations = readFileSync(counterFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    assert(
      invocations.length === 1,
      `case 9: the hung fixture ran exactly once (got ${invocations.length} invocations)`,
    );

    // (d) no orphan — the fixture spawned a `sleep` child with the token in
    // its args. Bounded poll (≤5s, 10 × 500ms) for the token's absence in
    // `ps` output: the watchdog's kill (TERM → bounded grace poll, 2s ceiling →
    // KILL) can race
    // with the process table on a loaded machine, so a single fixed sleep(1)
    // before the check could observe the still-dying child.
    let survivors: string[] = [];
    for (let i = 0; i < 10; i++) {
      const ps = spawnSync("ps", ["-o", "command", "-x"], { encoding: "utf-8" });
      const found = (ps.stdout ?? "")
        .split("\n")
        .filter((l) => l.includes(token) && !l.includes("ps -o"));
      if (found.length === 0) break;
      survivors = found;
      spawnSync("sleep", ["0.5"]);
    }
    assert(
      survivors.length === 0,
      `case 9: no orphaned process with the token remains (found ${survivors.length})`,
    );
  } finally {
    rmSync(counterFile, { force: true });
  }
}

// --- Case 10: timeout-only pipeline. A single hanging fixture (low bound)
// through the full consumer path must yield attributed: true and the
// `✗ timed out after <N>s` line as the specific assertion.
{
  const { env } = hangTestEnv("c10");
  const { attributed, assertion } = pipelineEnv([path.join(FIXTURES, "fixture-hang.ts")], env);
  assert(attributed, "case 10: tail is attributed (anchored on the FAILED marker)");
  // The timeout line is the specific assertion because the loop prepends
  // `✗ timed out after <N>s` to the front of the capture (so
  // extractSpecificAssertion sees it first) and the #827 echo in the loop
  // repeats it after the summary marker — that echo is what carries the line
  // into the 800-char marker-anchored tail this assertion arrives through.
  assert(
    assertion === "✗ timed out after 2s",
    `case 10: the specific assertion is the timeout line (got: ${JSON.stringify(assertion)})`,
  );
  assert(assertion !== NO_SPECIFIC_ASSERTION, "case 10: NOT honest-absence");
  assert(!assertion.startsWith("FAILED:"), "case 10: the assertion is not the summary marker");
}

// --- Case 11: exit-124 disambiguation (round-1 adversarial finding). A test
// that exits 124 of its own accord is NOT a timeout: the loop must report it
// as a plain `FAILED: <file>` without the "(timed out after <N>s)" suffix.
// The disambiguation marker (the `✗ timed out after <N>s` line) is prepended
// only by the watchdog, so a self-exit-124 test never gets it — the loop must
// not emit the cosmetic "timed out" suffix on the raw exit code alone.
{
  const { status, stdout } = runLoopEnv([path.join(FIXTURES, "fixture-exit124.ts")], {});
  assert(status !== 0, "case 11: exit non-zero when a test exits 124 of its own accord");
  const failedLines = stdout.split("\n").filter((l) => l.startsWith("FAILED: "));
  const perTest = failedLines.find((l) => l.includes("fixture-exit124.ts"));
  assert(
    perTest !== undefined,
    `case 11: the per-test FAILED marker names the file (got: ${JSON.stringify(perTest)})`,
  );
  assert(
    perTest !== undefined && !perTest.includes("(timed out"),
    `case 11: the exit-124 test is NOT misattributed as a timeout (got: ${JSON.stringify(perTest)})`,
  );
  assert(
    !stdout.includes("✗ timed out after"),
    "case 11: the ✗ timed out line is absent (the watchdog did not fire)",
  );
}

// --- Case 12: exit-214 disambiguation (#1365 fix round). The companion to
// case 11, one code along: the watchdog used to RETURN 214 when the bound
// fired and the caller keyed the timeout reporting on `rc -eq 214`, so a test
// that exits 214 itself — its own tooling's convention — was reported as
// "timed out" though nothing ever timed out. Timeout reporting is now keyed on
// the marker file the watchdog (and the pool's outer bound) writes, so this
// fixture gets a plain FAILED marker, keeps its real exit code as a failure,
// and no timeout text appears anywhere in the run.
{
  const { status, stdout } = runLoopEnv([path.join(FIXTURES, "fixture-exit214.ts")], {});
  assert(status !== 0, "case 12: exit non-zero when a test exits 214 of its own accord");
  const failedLines = stdout.split("\n").filter((l) => l.startsWith("FAILED: "));
  const perTest = failedLines.find((l) => l.includes("fixture-exit214.ts"));
  assert(
    perTest !== undefined,
    `case 12: the per-test FAILED marker names the file (got: ${JSON.stringify(perTest)})`,
  );
  assert(
    perTest !== undefined && !perTest.includes("(timed out"),
    `case 12: the exit-214 test is NOT misattributed as a timeout (got: ${JSON.stringify(perTest)})`,
  );
  assert(
    !stdout.includes("timed out"),
    "case 12: no timeout text at all in the run (the watchdog never fired)",
  );
  assert(
    stdout.includes("fixture-exit214: intentional self-exit-214"),
    "case 12: the test's own output is reported, so the real failure is visible",
  );
  const summaryLine = failedLines.filter((l) => l.includes("test(s)")).pop();
  assert(
    (summaryLine ?? "").includes("fixture-exit214.ts"),
    `case 12: the summary counts it as a failure (got: ${JSON.stringify(summaryLine)})`,
  );
}

console.log(exit === 0 ? "\nAll verify-loop timeout checks passed." : "\nFAILED");
process.exit(exit);
