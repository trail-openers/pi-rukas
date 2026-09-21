/**
 * test-verify-full — offline smoke tests for the verify-full tier.
 *
 * Issue #279 — verify the verify-full command discovery, execution,
 * and ci-step integration work correctly. All tests use injected execFn
 * to avoid real shell execution.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_CI_RETRIES } from "../src/work-driver-context.ts";
import { runVerifyFull, verifyCmdFullFor } from "../src/work-driver-verify-full.ts";

// Temporary directory for test fixtures
let tmpDir: string;

/** Create a temp directory for test files */
async function setupTmpDir() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-full-test-"));
}

/** Clean up temp directory */
async function cleanupTmpDir() {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

/** Mock execFn that tracks calls and returns controlled results */
function createMockExecFn(
  results: Array<{ stdout: string; stderr?: string }>,
  trackCalls: Array<{ cmd: string; cwd?: string }> = [],
) {
  let idx = 0;
  // Signature must mirror the real ExecFn: `(cmd, opts)`, two positional
  // arguments. The original mock destructured a single `{cmd, cwd}` object, so
  // every recorded call had `cmd: undefined` — a mismatch that survived only
  // because this file was never executed.
  return async (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr?: string }> => {
    trackCalls.push({ cmd, cwd: opts?.cwd });
    // Out-of-bounds calls (e.g. a flake retry when the test only provided one
    // result) also throw — the mock's contract is "unscripted calls fail",
    // which matches the #782 flake-retry semantics (a retry that has no
    // scripted result is a genuine second failure).
    if (idx >= results.length) {
      throw new Error("error: unexpected call");
    }
    const result = results[idx++];
    if (result.stderr?.startsWith("error:")) {
      throw new Error(result.stderr);
    }
    return result;
  };
}

/** Test: verifyCmdFullFor returns undefined when file is absent */
async function testVerifyCmdFullForAbsent() {
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, undefined, "should return undefined when .pi/verify-cmd-full absent");
  console.log("✓ testVerifyCmdFullForAbsent");
}

/** Test: verifyCmdFullFor reads the first non-empty line */
async function testVerifyCmdFullForPresent() {
  const piDir = path.join(tmpDir, ".pi");
  await fs.mkdir(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd-full");
  await fs.writeFile(
    cmdFile,
    `# Full verify command
cargo test --workspace
`,
  );
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, "cargo test --workspace");
  console.log("✓ testVerifyCmdFullForPresent");
}

/** Test: verifyCmdFullFor skips comments */
async function testVerifyCmdFullForSkipsComments() {
  const piDir = path.join(tmpDir, ".pi");
  await fs.mkdir(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd-full");
  await fs.writeFile(
    cmdFile,
    `# Comment 1
# Comment 2
bun test --coverage
`,
  );
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, "bun test --coverage");
  console.log("✓ testVerifyCmdFullForSkipsComments");
}

/** Test: verifyCmdFullFor handles empty lines */
async function testVerifyCmdFullForEmptyLines() {
  const piDir = path.join(tmpDir, ".pi");
  await fs.mkdir(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd-full");
  await fs.writeFile(
    cmdFile,
    `

npm run test
`,
  );
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, "npm run test");
  console.log("✓ testVerifyCmdFullForEmptyLines");
}

/** Test: verifyCmdFullFor reads command verbatim (no derivation) */
async function testVerifyCmdFullForVerbatim() {
  const piDir = path.join(tmpDir, ".pi");
  await fs.mkdir(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd-full");
  const verbatimCmd = "cargo test --all --all-features -- --nocapture";
  await fs.writeFile(cmdFile, verbatimCmd);
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, verbatimCmd, "command should be read verbatim");
  console.log("✓ testVerifyCmdFullForVerbatim");
}

/** Test: runVerifyFull returns success on zero exit */
async function testRunVerifyFullSuccess() {
  const trackCalls: Array<{ cmd: string; cwd?: string }> = [];
  const mockExec = createMockExecFn(
    [{ stdout: "test result: 23 passed, 0 failed", stderr: "" }],
    trackCalls,
  );
  const result = await runVerifyFull("cargo test", tmpDir, 5000, mockExec);
  assert.strictEqual(result.outcome, "success");
  // A mock resolves in well under a millisecond, so `> 0` is a timing
  // assumption, not a contract. What matters is that elapsed is measured and
  // non-negative; the delayed case below proves it actually advances.
  assert.ok(Number.isFinite(result.ms) && result.ms >= 0);
  assert.strictEqual(result.output, "test result: 23 passed, 0 failed");
  assert.strictEqual(trackCalls.length, 1);
  assert.strictEqual(trackCalls[0].cmd, "cargo test");
  assert.strictEqual(trackCalls[0].cwd, tmpDir);
  console.log("✓ testRunVerifyFullSuccess");
}

/** Test: runVerifyFull returns failure on non-zero exit */
async function testRunVerifyFullFailure() {
  const trackCalls: Array<{ cmd: string; cwd?: string }> = [];
  const mockExec = createMockExecFn([{ stdout: "", stderr: "error: test failed" }], trackCalls);
  const result = await runVerifyFull("cargo test", tmpDir, 5000, mockExec);
  assert.strictEqual(result.outcome, "failure");
  // A mock resolves in well under a millisecond, so `> 0` is a timing
  // assumption, not a contract. What matters is that elapsed is measured and
  // non-negative; the delayed case below proves it actually advances.
  assert.ok(Number.isFinite(result.ms) && result.ms >= 0);
  assert.ok(result.output.includes("error: test failed"));
  console.log("✓ testRunVerifyFullFailure");
}

/** Test: runVerifyFull handles stdout as evidence when stderr is absent */
async function testRunVerifyFullEvidenceStdout() {
  const mockExec = createMockExecFn([
    { stdout: "PASS  Test Suite (1000 ms)\nFAIL  Some Test (50 ms)" },
  ]);
  const result = await runVerifyFull("npm test", tmpDir, 5000, mockExec);
  assert.strictEqual(result.outcome, "success");
  assert.ok(result.output.includes("PASS"));
  console.log("✓ testRunVerifyFullEvidenceStdout");
}

/**
 * Test: stderr becomes the evidence when stdout is empty, WITHOUT that alone
 * meaning failure.
 *
 * The exit code is the contract — `promisify(exec)` rejects on non-zero, so a
 * throw is the failure signal and is covered by testRunVerifyFullFailure. Many
 * test runners write progress and warnings to stderr while exiting 0; treating
 * stderr presence as failure would fail nearly every real verify command.
 * (The original assertion expected "failure" here, and its mock did not even
 * throw — it could never have passed.)
 */
async function testRunVerifyFullEvidenceStderr() {
  const mockExec = createMockExecFn([
    { stdout: "", stderr: "warning: 3 unused imports\nSee output above" },
  ]);
  const result = await runVerifyFull("cargo test", tmpDir, 5000, mockExec);
  assert.strictEqual(result.outcome, "success", "exit 0 is success even with stderr output");
  assert.ok(result.output.includes("warning"), "stderr is used as evidence when stdout is empty");
  console.log("✓ testRunVerifyFullEvidenceStderr");
}

/** Test: runVerifyFull respects cwd parameter */
async function testRunVerifyFullCwd() {
  const worktreePath = path.join(tmpDir, "worktree");
  await fs.mkdir(worktreePath, { recursive: true });

  const trackCalls: Array<{ cmd: string; cwd?: string }> = [];
  const mockExec = createMockExecFn([{ stdout: "" }], trackCalls);

  await runVerifyFull("bun test", worktreePath, 5000, mockExec);
  assert.strictEqual(trackCalls.length, 1);
  assert.strictEqual(trackCalls[0].cwd, worktreePath);
  assert.notStrictEqual(trackCalls[0].cwd, tmpDir);
  console.log("✓ testRunVerifyFullCwd");
}

/**
 * #782 — a flake re-runs once: the first run fails, the bounded re-run
 * passes. The result is a success with `recovered: true` and the FIRST run's
 * failing tail preserved as `firstRunOutput` (so the caller can surface what
 * the flake looked like on the verify-full-status event).
 */
async function testRunVerifyFullFlakeRecovered() {
  const trackCalls: Array<{ cmd: string; cwd?: string }> = [];
  const mockExec = createMockExecFn(
    [
      { stdout: "", stderr: "error: test failed" },
      { stdout: "test result: 23 passed, 0 failed", stderr: "" },
    ],
    trackCalls,
  );
  const result = await runVerifyFull("cargo test", tmpDir, 5000, mockExec, { retry: true });
  assert.strictEqual(result.outcome, "success", "recovered re-run is a success");
  assert.strictEqual(result.recovered, true, "recovered flag set");
  assert.ok(
    result.firstRunOutput?.includes("error: test failed"),
    "first run's failing tail preserved",
  );
  assert.strictEqual(trackCalls.length, 2, "exactly one re-run (bounded, not a loop)");
  assert.strictEqual(trackCalls[0].cmd, trackCalls[1].cmd, "same command re-run");
  assert.strictEqual(trackCalls[0].cwd, trackCalls[1].cwd, "same worktree re-run");
  console.log("✓ testRunVerifyFullFlakeRecovered");
}

/**
 * #782 — a test that fails TWICE is not a flake. The re-run is bounded to
 * exactly one, the result is a failure, no `recovered` flag, and the second
 * (most recent) tail is the primary evidence.
 */
async function testRunVerifyFullFlakeStillFails() {
  const trackCalls: Array<{ cmd: string; cwd?: string }> = [];
  const mockExec = createMockExecFn(
    [
      { stdout: "", stderr: "error: test failed (run 1)" },
      { stdout: "", stderr: "error: test failed (run 2)" },
    ],
    trackCalls,
  );
  const result = await runVerifyFull("cargo test", tmpDir, 5000, mockExec, { retry: true });
  assert.strictEqual(result.outcome, "failure", "two failures is a genuine failure");
  assert.strictEqual(result.recovered, undefined, "no recovered flag on genuine failure");
  assert.ok(result.output.includes("run 2"), "most recent tail is the primary evidence");
  assert.ok(
    result.firstRunOutput?.includes("run 1"),
    "first run's failing tail preserved",
  );
  assert.strictEqual(trackCalls.length, 2, "exactly one re-run, never a loop");
  console.log("✓ testRunVerifyFullFlakeStillFails");
}

/**
 * #782 — the retry is opt-in. A caller that does not pass `retry` keeps the
 * pre-#782 single-run shape: one failing run is a failure and NO second call
 * is made (a caller that never opts in must not pay for a re-run).
 */
async function testRunVerifyFullNoRetryWhenOptOut() {
  const trackCalls: Array<{ cmd: string; cwd?: string }> = [];
  const mockExec = createMockExecFn(
    [{ stdout: "", stderr: "error: test failed" }],
    trackCalls,
  );
  const result = await runVerifyFull("cargo test", tmpDir, 5000, mockExec);
  assert.strictEqual(result.outcome, "failure");
  assert.strictEqual(result.recovered, undefined);
  assert.strictEqual(trackCalls.length, 1, "no re-run without retry opt-in");
  console.log("✓ testRunVerifyFullNoRetryWhenOptOut");
}

/** Test: runVerifyFull measures elapsed time, not just reports zero */
async function testRunVerifyFullMeasuresElapsed() {
  const slowExec = async () => {
    await new Promise((r) => setTimeout(r, 25));
    return { stdout: "ok", stderr: "" };
  };
  const result = await runVerifyFull("slow", tmpDir, 5000, slowExec);
  assert.ok(result.ms >= 20, `elapsed should reflect real duration, got ${result.ms}ms`);
  console.log("✓ testRunVerifyFullMeasuresElapsed");
}

/** Run all tests */
export async function run() {
  await setupTmpDir();
  try {
    await testVerifyCmdFullForAbsent();
    await testVerifyCmdFullForPresent();
    await testVerifyCmdFullForSkipsComments();
    await testVerifyCmdFullForEmptyLines();
    await testVerifyCmdFullForVerbatim();
    await testRunVerifyFullSuccess();
    await testRunVerifyFullFailure();
    await testRunVerifyFullEvidenceStdout();
    await testRunVerifyFullEvidenceStderr();
    await testRunVerifyFullCwd();
    await testRunVerifyFullFlakeRecovered();
    await testRunVerifyFullFlakeStillFails();
    await testRunVerifyFullNoRetryWhenOptOut();
    await testRunVerifyFullMeasuresElapsed();
    console.log("\n✓ All verify-full tests passed");
  } finally {
    await cleanupTmpDir();
  }
}

// The invocation. Without it this file defines its tests and executes none:
// `bun run` prints nothing and exits 0, so the suite counted it as passing
// while the subsystem had zero coverage. A gate that cannot fail is worse
// than no gate — EPIC #328, reproduced inside #279 itself.
run().catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
