#!/usr/bin/env bun
/**
 * Issue #803 — verify-loop: run-all smoke-test loop.
 *
 * Tests the shared loop at smoke-tests/lib/verify-loop.sh against the
 * fixture scripts in smoke-tests/fixtures/verify-loop/.
 *
 * Cases:
 *   1. Five fixtures where 1, 3, 5 fail: all three named in the summary,
 *      exit non-zero, final line is the summary marker.
 *   2. All-pass fixture set: exit 0, no summary marker.
 *   3. Truncation: a failure set whose details exceed 800 chars;
 *      extractAttributedTail(output, 800) still yields the summary line.
 *   4. Single-execution: a fixture that appends to a counter file;
 *      assert it ran exactly once despite failing.
 *   5. Live-exclusion canary: a *-live.ts fixture in the argument list must
 *      be skipped — not executed (sentinel file absent), not counted in the
 *      summary, not present in the output.
 *   6. #827 #772-shape: a failing test whose ✗ lines sit thousands of chars
 *      before the final summary — the marker-anchored 800-char tail must
 *      still name the real ✗ assertion and the failing test file (the full
 *      pipeline: verify-loop.sh → extractAttributedTail →
 *      extractSpecificAssertion → classifyConsolidatedVerifyFailure).
 *      fixture-2.ts, passed first in the loop, is a deliberately-passing
 *      control: its output must not be echoed (only failing tests' ✗ lines
 *      are repeated after the summary).
 *   7. #827 multi-failure: two failing tests, one with two ✗ lines — the
 *      FIRST real ✗ is the specific assertion and the summary names all
 *      failing files within the 800-char bound.
 *   8. #1017 spawn-guard canary: verify-loop.sh exports
 *      PI_ENSEMBLE_FORBID_LIVE_SPAWN=1 into the child test env (the fixture
 *      prints the guard; under the loop it is "1" and ALLOW is unset; run
 *      directly by bun it is unset) — so an offline test that reaches the
 *      real spawn path fails loudly instead of burning tokens.
 *   9. #1014 timeout: hanging fixture (low override) → marker + ✗ line +
 *       partial output + summary, loop continues, exactly-once, no orphan,
 *       and the timeout-only pipeline yields attributed: true.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NO_SPECIFIC_ASSERTION,
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
  extractSpecificAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(__dirname, "fixtures", "verify-loop");
const SCRIPT = path.join(__dirname, "lib", "verify-loop.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function runLoop(files: string[]): { status: number; stdout: string } {
  const result = spawnSync("bash", [SCRIPT, ...files], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout };
}

// #1014 — run the loop with an env override (low PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S).
function runLoopEnv(
  files: string[],
  env: Record<string, string>,
): { status: number; stdout: string } {
  const r = spawnSync("bash", [SCRIPT, ...files], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout };
}

// #1014 — full consumer path with env override.
function pipelineEnv(
  files: string[],
  env: Record<string, string>,
): { tail: string; attributed: boolean; assertion: string } {
  const { stdout } = runLoopEnv(files, env);
  const { tail, attributed } = extractAttributedTail(stdout, 800);
  return { tail, attributed, assertion: extractSpecificAssertion(tail) };
}

// --- Case 1: 5 fixtures, 1/3/5 fail ---
{
  const files = [1, 2, 3, 4, 5].map((n) => path.join(FIXTURES, `fixture-${n}.ts`));
  const { status, stdout } = runLoop(files);
  const lines = stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1];

  assert(status !== 0, "case 1: exit non-zero when any test fails");
  assert(
    lastLine.startsWith("FAILED: 3 test(s) —"),
    "case 1: final line is summary marker with count 3",
  );
  assert(
    lastLine.includes("fixture-1.ts") &&
      lastLine.includes("fixture-3.ts") &&
      lastLine.includes("fixture-5.ts"),
    "case 1: summary names all three failing fixtures",
  );
  assert(
    !lastLine.includes("fixture-2.ts") && !lastLine.includes("fixture-4.ts"),
    "case 1: summary does not name passing fixtures",
  );

  // Per-failure markers retained
  const markers = stdout
    .split("\n")
    .filter((l) => /^FAILED: .*fixture-\d\.ts$/.test(l) && !/test\(s\)/.test(l));
  assert(markers.length === 3, `case 1: 3 per-failure FAILED markers (got ${markers.length})`);
}

// --- Case 2: all-pass ---
{
  const files = [path.join(FIXTURES, "allpass-a.ts"), path.join(FIXTURES, "allpass-b.ts")];
  const { status, stdout } = runLoop(files);
  assert(status === 0, "case 2: exit 0 when all pass");
  assert(!stdout.includes("FAILED:"), "case 2: no FAILED marker on all-pass run");
}

// --- Case 3: truncation via extractAttributedTail ---
{
  // Use the verbose fixture (produces ~2000 chars) plus the 3 failing fixtures
  // so the total output well exceeds 800 chars.
  const files = [
    path.join(FIXTURES, "fixture-1.ts"),
    path.join(FIXTURES, "fixture-3.ts"),
    path.join(FIXTURES, "fixture-verbose.ts"),
    path.join(FIXTURES, "fixture-5.ts"),
  ];
  const { stdout } = runLoop(files);
  assert(stdout.length > 800, `case 3: output exceeds 800 chars (${stdout.length})`);

  const { tail, attributed } = extractAttributedTail(stdout, 800);
  assert(attributed, "case 3: tail is attributed (anchored on a FAILED marker)");
  assert(tail.startsWith("FAILED: 4 test(s) —"), "case 3: summary marker survives truncation");
  assert(tail.includes("fixture-1.ts"), "case 3: leading name survives truncation");
  assert(tail.length <= 800, `case 3: tail respects maxLen 800 (got ${tail.length})`);
}

// --- Case 4: single-execution ---
{
  const counterFile = path.join(tmpdir(), `verify-loop-counter-${process.pid}`);
  rmSync(counterFile, { force: true });
  writeFileSync(counterFile, "");

  try {
    const files = [path.join(FIXTURES, "fixture-counter.ts")];
    // Pass the counter file path via env
    const result = spawnSync("bash", [SCRIPT, ...files], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, FIXTURE_COUNTER_FILE: counterFile },
    });
    const lines = readFileSync(counterFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    assert(
      lines.length === 1,
      `case 4: fixture ran exactly once (got ${lines.length} invocations)`,
    );
  } finally {
    rmSync(counterFile, { force: true });
  }
}

// --- Case 5: live-exclusion canary ---
{
  // A *-live.ts file that, if executed, writes a sentinel and exits 1.
  const sentinel = path.join(mkdtempSync(path.join(tmpdir(), "verify-loop-live-")), "sentinel");
  rmSync(sentinel, { force: true });

  const files = [
    path.join(FIXTURES, "allpass-a.ts"),
    path.join(FIXTURES, "fixture-spawn-live.ts"),
    path.join(FIXTURES, "allpass-b.ts"),
  ];
  const result = spawnSync("bash", [SCRIPT, ...files], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
    env: { ...process.env, FIXTURE_LIVE_SENTINEL: sentinel },
  });
  const { status, stdout } = { status: result.status ?? -1, stdout: result.stdout };

  assert(!existsSync(sentinel), "case 5: live fixture was NOT executed (sentinel absent)");
  assert(status === 0, "case 5: exit 0 — the skipped file is not a failure");
  assert(!stdout.includes("fixture-spawn-live"), "case 5: skipped live file absent from output");
  assert(
    !stdout.includes("FAILED:"),
    "case 5: no summary marker on a run where only a live file was skipped",
  );
}

// --- #827 shared pipeline: loop output → tail → assertion → classification.
function runPipeline(files: string[]): {
  stdout: string;
  tail: string;
  attributed: boolean;
  assertion: string;
  verdict: ReturnType<typeof classifyConsolidatedVerifyFailure>;
  message: string;
} {
  const { stdout } = runLoop(files);
  const { tail, attributed } = extractAttributedTail(stdout, 800);
  const assertion = extractSpecificAssertion(tail);
  // N>1 no per-worktree failures — the consolidated-failure consumer shape.
  const verdict = classifyConsolidatedVerifyFailure(2, ["a", "b"], tail, {});
  return {
    stdout,
    tail,
    attributed,
    assertion,
    verdict,
    message: consolidatedFailureMessage(verdict, "bun run check"),
  };
}

// --- Case 6: #772 shape — the failing test's ✗ lines sit far above the
// summary; the 800-char tail must name the real ✗ assertion.
{
  const scratch = mkdtempSync(path.join(tmpdir(), "verify-loop-772-"));
  const bigFixture = path.join(scratch, "fixture-shape-772.ts");
  const rows: string[] = [];
  for (let i = 0; i < 120; i++) {
    rows.push(
      `  ${String(i).padStart(3)}  extension/src/module-${String(i).padStart(3)}.ts  ${100 + i} lines (ok)`,
    );
  }
  const rowLines = rows.map((r) => `console.log(${JSON.stringify(r)});`).join("\n");
  const fixtureSource = [
    "#!/usr/bin/env bun",
    "console.log('shape-772: checking files against the 500-line hard limit');",
    rowLines,
    "console.log('scan complete — checking limits:');",
    "console.error('✗ extension/src/module-999.ts: 667 lines (exceeds 500-line hard limit)');",
    "console.error('✗ extension/src/module-998.ts: 528 lines (exceeds 500-line hard limit)');",
    "process.exit(1);",
  ].join("\n");
  writeFileSync(bigFixture, fixtureSource, "utf-8");
  // Note: the fixture file is intentionally NOT cleaned up — it lives in the
  // OS tmp dir, is regenerated fresh each run (new mkdtemp), and the loop
  // invokes it by absolute path; /tmp is reaped by the OS.
  void scratch;

  const { stdout, tail, attributed, assertion, verdict, message } = runPipeline([
    path.join(FIXTURES, "fixture-2.ts"),
    bigFixture,
    path.join(FIXTURES, "fixture-verbose.ts"),
  ]);
  assert(
    stdout.length > 4000,
    `case 6 (#772 shape): output is multi-KB (${stdout.length} chars), so the ✗ lines sit far above the summary`,
  );
  assert(
    tail.length <= 800,
    `case 6 (#772 shape): the 800-char bound is preserved (got ${tail.length})`,
  );
  assert(attributed, "case 6 (#772 shape): tail is attributed (anchored on the FAILED marker)");
  assert(
    assertion === "✗ extension/src/module-999.ts: 667 lines (exceeds 500-line hard limit)",
    `case 6 (#772 shape): the report names the real ✗ assertion (got: ${JSON.stringify(assertion)})`,
  );
  assert(
    assertion !== NO_SPECIFIC_ASSERTION,
    "case 6 (#772 shape): NOT honest-absence — the #772 defect was NO_SPECIFIC_ASSERTION here",
  );
  assert(
    !assertion.startsWith("FAILED:"),
    "case 6 (#772 shape): the assertion is not the summary marker",
  );
  assert(
    tail.includes("fixture-verbose.ts") || tail.includes(bigFixture.replace(/\\/g, "/")),
    "case 6 (#772 shape): the failing test file survives in the tail (summary names it)",
  );
  assert(
    message.includes("667 lines"),
    `case 6 (#772 shape): the failure message carries the ✗ line, not '${NO_SPECIFIC_ASSERTION}'`,
  );
  // The #772 misattribution: a size-cap failure classified as a human
  // design decision instead of the trivial size-cap shape.
  assert(
    verdict.trivialFix,
    `case 6 (#772 shape): the size-cap union shape is recognised (trivialFix), not parked as a design decision (got: ${verdict.classification}, trivialFix=${verdict.trivialFix})`,
  );
}

// --- Case 7: multi-failure — two failing tests, one of which carries two
// ✗ lines. The FIRST real ✗ is the specific assertion; the summary lists
// ALL failing files; the 800-char bound holds.
{
  const { stdout, tail, assertion, verdict, message } = runPipeline([
    path.join(FIXTURES, "fixture-1.ts"),
    path.join(FIXTURES, "fixture-multi.ts"),
    path.join(FIXTURES, "fixture-3.ts"),
  ]);
  assert(
    stdout.length > 800,
    `case 7 (multi-failure): output exceeds the 800-char bound (${stdout.length} chars)`,
  );
  assert(
    tail.length <= 800,
    `case 7 (multi-failure): the 800-char bound is preserved (got ${tail.length})`,
  );
  assert(
    tail.startsWith("FAILED: 3 test(s) —"),
    "case 7 (multi-failure): the tail anchors on the summary marker",
  );
  assert(
    tail.includes("fixture-1.ts") &&
      tail.includes("fixture-multi.ts") &&
      tail.includes("fixture-3.ts"),
    "case 7 (multi-failure): the summary in the tail names ALL failing files",
  );
  // The #807 first-assertion rule: exactly ONE ✗ line is named — the first
  // in the echoed block (loop order = argument order) — and fixture-multi's
  // second ✗ line is NOT duplicated into the assertion field.
  assert(
    assertion === "✗ fixture-1: assertion failed: expected 200, got 404" ||
      assertion === "✗ fixture-multi: first assertion: expected 'alpha', got 'beta'",
    `case 7 (multi-failure): the FIRST real ✗ is the specific assertion (got: ${JSON.stringify(assertion)})`,
  );
  assert(
    !assertion.includes("second assertion"),
    "case 7 (multi-failure): fixture-multi's SECOND ✗ line is not the named assertion (first-assertion rule)",
  );
  assert(
    !assertion.startsWith("FAILED:") && !assertion.startsWith("$ "),
    "case 7 (multi-failure): never a marker or echoed command",
  );
  assert(
    !verdict.assertion.startsWith("FAILED:"),
    "case 7 (multi-failure): the classification's assertion is a real line",
  );
  assert(
    message.includes("✗"),
    "case 7 (multi-failure): the failure message names a real ✗ assertion, not absence",
  );
}

// --- Case 8: #1017 spawn-guard canary — verify-loop.sh exports the guard
// into every offline test's child env.
{
  const fixture = path.join(FIXTURES, "fixture-spawn-env.ts");

  // Direct invocation: delete the guard export from the inherited env so the
  // "unset" reading is the absence itself, not a leftover the gate set.
  const directEnv = { ...process.env };
  delete directEnv.PI_ENSEMBLE_FORBID_LIVE_SPAWN;
  delete directEnv.PI_ENSEMBLE_ALLOW_LIVE_SPAWN;
  const direct = spawnSync("bun", ["run", fixture], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
    env: directEnv,
  });
  const directLines = (direct.stdout ?? "").split("\n");
  assert(
    directLines.includes("GUARD=(unset)"),
    `case 8 (direct): the guard is unset outside the gate (got: ${JSON.stringify(directLines)})`,
  );

  // Under the loop: the export must reach the child, and the ALLOW bypass
  // must NOT (a test setting ALLOW locally is its own business, but the
  // gate must not be the one that sets it).
  const { status, stdout } = runLoop([fixture]);
  const loopLines = stdout.split("\n").filter((l) => l.startsWith("GUARD=") || l.startsWith("ALLOW="));
  assert(
    loopLines.includes("GUARD=1"),
    `case 8 (loop): verify-loop.sh exports PI_ENSEMBLE_FORBID_LIVE_SPAWN=1 into the child (got: ${JSON.stringify(loopLines)})`,
  );
  assert(
    loopLines.includes("ALLOW=(unset)"),
    `case 8 (loop): the gate does NOT set the PI_ENSEMBLE_ALLOW_LIVE_SPAWN bypass (got: ${JSON.stringify(loopLines)})`,
  );
  assert(status === 0, "case 8 (loop): the canary fixture itself passes under the gate");
}

// #1014 timeout cases: PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S=2, hanging fixture
// spawns a `sleep` child with a run-unique token (FIXTURE_HANG_TOKEN).
// --- Case 9: timeout reporting + continue-after-timeout.
{
  const t0 = Date.now();
  const token = `hang-c9-${process.pid}-${Date.now()}`;
  const counterFile = path.join(tmpdir(), `verify-loop-hang-counter-${process.pid}`);
  rmSync(counterFile, { force: true });
  try {
    const { status, stdout } = runLoopEnv(
      [
        path.join(FIXTURES, "fixture-hang-counter.ts"),
        path.join(FIXTURES, "fixture-1.ts"),
        path.join(FIXTURES, "allpass-a.ts"),
      ],
      {
        PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: "2",
        FIXTURE_HANG_TOKEN: token,
        FIXTURE_COUNTER_FILE: counterFile,
      },
    );
    const elapsed = (Date.now() - t0) / 1000;
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1];

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
      (summaryLine ?? "").includes("fixture-hang-counter.ts") && (summaryLine ?? "").includes("fixture-1.ts"),
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
    // its args. After the watchdog kill, no live process carries the token.
    spawnSync("sleep", ["1"]);
    const ps = spawnSync("ps", ["-o", "command", "-x"], { encoding: "utf-8" });
    const survivors = (ps.stdout ?? "").split("\n").filter((l) => l.includes(token) && !l.includes("ps -o"));
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
  const token = `hang-c10-${process.pid}-${Date.now()}`;
  const { tail, attributed, assertion } = pipelineEnv(
    [path.join(FIXTURES, "fixture-hang.ts")],
    { PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: "2", FIXTURE_HANG_TOKEN: token },
  );
  assert(attributed, "case 10: tail is attributed (anchored on the FAILED marker)");
  assert(
    assertion === "✗ timed out after 2s",
    `case 10: the specific assertion is the timeout line (got: ${JSON.stringify(assertion)})`,
  );
  assert(assertion !== NO_SPECIFIC_ASSERTION, "case 10: NOT honest-absence");
  assert(!assertion.startsWith("FAILED:"), "case 10: the assertion is not the summary marker");
}

console.log(exit === 0 ? "\nAll verify-loop checks passed." : "\nFAILED");
process.exit(exit);
