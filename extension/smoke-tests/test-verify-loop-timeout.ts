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
// (the poll loop is 1s-resolution, the kill has a 2s grace → each ~4-5s, not
// the 300s default) plus a run-unique FIXTURE_HANG_TOKEN — the fixture bakes
// it into a `sleep` child's command line so the no-orphan check can find the
// descendant by pattern after the kill (the pid is not reliable: ps output
// can elide args, and the watchdog does not expose the child's pid).
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
      summaryLine !== undefined && summaryLine.startsWith("FAILED: 2 test(s) —"),
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
    // `ps` output: the watchdog's kill (TERM → 2s grace → KILL) can race
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

console.log(exit === 0 ? "\nAll verify-loop timeout checks passed." : "\nFAILED");
process.exit(exit);
