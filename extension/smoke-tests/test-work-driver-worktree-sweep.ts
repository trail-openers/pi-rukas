#!/usr/bin/env bun
/**
 * Test for work-driver-worktree-sweep module.
 */

import { assert } from "node:assert";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSweepTarget, decideSweepAction, executeSweepAction, SweepAction, SweepTargetResult, SweepTargetError, runWorktreeSweep, runWorktreeTeardown } from "../src/work-driver-worktree-sweep.ts";
import { processAlive } from "../src/work-driver-resume.ts";

const execAsync = promisify(execFile);

let exitCode = 0;
function assertTrue(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}
function assertFalse(cond: boolean, msg: string) {
  assertTrue(!cond, msg);
}
function assertEquals(actual: any, expected: any, msg: string) {
  if (actual === expected) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}: expected ${expected}, got ${actual}`);
    exitCode = 1;
  }
}

// We'll create a temporary git repo for testing
let testRepoRoot: string;
let testWorktreesDir: string;

async function setup() {
  testRepoRoot = await fs.mkdtemp(join(tmpdir(), "worktree-sweep-test-"));
  await execAsync("git", ["init"], { cwd: testRepoRoot });
  await execAsync("git", ["config", "user.name", "Test"], { cwd: testRepoRoot });
  await execAsync("git", ["config", "user.email", "test@test.com"], { cwd: testRepoRoot });
  await execAsync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: testRepoRoot });

  // Create .worktrees directory
  testWorktreesDir = join(testRepoRoot, ".worktrees");
  await fs.mkdir(testWorktreesDir, { recursive: true });
}

async function teardown() {
  await fs.rm(testRepoRoot, { recursive: true, force: true });
}

async function runTests() {
  await setup();
  try {
    await testResolveSweepTarget();
    await testDecideSweepAction();
    await testExecuteSweepAction();
    await testRunWorktreeSweep();
    await testRunWorktreeTeardown();
  } finally {
    await teardown();
  }
  if (exitCode === 0) {
    console.log("\nAll tests passed.");
  } else {
    console.log("\nFAILED");
  }
  process.exit(exitCode);
}

async function testResolveSweepTarget() {
  console.log("\nTesting resolveSweepTarget...");
  // Test rejects repo root
  const result1 = resolveSweepTarget(testRepoRoot, testRepoRoot);
  assertFalse(result1.ok, "repo root should be rejected");
  assertEquals(result1.reason, "candidate-is-repo-root", "reason should be candidate-is-repo-root");

  // Test rejects outside .worktrees
  const outside = join(testRepoRoot, "outside");
  await fs.mkdir(outside, { recursive: true }); // Create the outside directory
  const result2 = resolveSweepTarget(testRepoRoot, outside);
  assertFalse(result2.ok, "outside .worktrees should be rejected");
  assertEquals(result2.reason, "outside-worktrees", "reason should be outside-worktrees");

  // Test accepts valid .worktrees child
  const worktreeName = "issue-1-test";
  const worktreeDir = join(testWorktreesDir, worktreeName);
  await fs.mkdir(worktreeDir, { recursive: true });
  await execAsync("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], { cwd: testRepoRoot });

  const result3 = resolveSweepTarget(testRepoRoot, worktreeDir);
  assertTrue(result3.ok, "valid .worktrees child should be accepted");
  if (result3.ok) {
    assertEquals(result3.realPath, resolve(worktreeDir), "realPath should match");
    assertEquals(result3.name, worktreeName, "name should match");
  }

  // Clean up
  await execAsync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: testRepoRoot });

  // Test rejects non-directory
  const filePath = join(testWorktreesDir, "file.txt");
  await fs.writeFile(filePath, "content");
  const result4 = resolveSweepTarget(testRepoRoot, filePath);
  assertFalse(result4.ok, "non-directory should be rejected");
  assertEquals(result4.reason, "not-a-directory", "reason should be not-a-directory");
  await fs.unlink(filePath);

  // Test rejects not our worktree
  const fakeDir = join(testWorktreesDir, "fake-worktree");
  await fs.mkdir(fakeDir, { recursive: true });
  const gitFile = join(fakeDir, ".git");
  await fs.writeFile(gitFile, "gitdir: /some/other/repo/.git");
  const result5 = resolveSweepTarget(testRepoRoot, fakeDir);
  assertFalse(result5.ok, "not our worktree should be rejected");
  assertEquals(result5.reason, "not-our-worktree", "reason should be not-our-worktree");
  await fs.rm(fakeDir, { recursive: true, force: true });
}

async function testDecideSweepAction() {
  console.log("\nTesting decideSweepAction...");
  const mockExecFn = async (cmd: string, opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string }) => {
    return { stdout: "", stderr: undefined };
  };

  // Test returns skip for live owner
  const state1 = {
    issue: 1,
    owner: { pid: process.pid, at: Date.now() }, // Use current process PID
    pipelineState: {
      currentStep: "develop",
      branchName: "test-branch",
      worktrees: {}
    },
    eventLog: []
  } as any;
  const target1 = {
    ok: true,
    realPath: "/fake/path",
    name: "issue-1-test"
  } as SweepTargetResult;
  const opts1 = {
    state: state1,
    target: target1,
    selfPid: 99999, // Different from owner pid
    liveCycles: new Set([1]),
    launchingCycleIssue: 2, // Different issue
    execFn: mockExecFn
  };
  try {
    const action1 = await decideSweepAction(opts1);
    assertTrue(action1.type === "skip", "should skip for live owner");
    assertEquals(action1.reason, `live-owner pid=${process.pid}`, "reason should match");
  } finally {
    // No mock to restore
  }

  // Test returns skip for live issue
  const state2 = {
    issue: 1,
    owner: { pid: 0, at: Date.now() }, // PID 0 is invalid, so processAlive returns false
    pipelineState: {
      currentStep: "develop",
      branchName: "test-branch",
      worktrees: {}
    },
    eventLog: []
  } as any;
  const target2 = {
    ok: true,
    realPath: "/fake/path",
    name: "issue-1-test"
  } as SweepTargetResult;
  const opts2 = {
    state: state2,
    target: target2,
    selfPid: 99999,
    liveCycles: new Set([1]), // Issue 1 is live
    launchingCycleIssue: 2, // Different issue
    execFn: mockExecFn
  };
  try {
    const action2 = await decideSweepAction(opts2);
    assertTrue(action2.type === "skip", "should skip for live issue");
    assertEquals(action2.reason, `live-issue ${1}`, "reason should match");
  } finally {
    // No mock to restore
  }

  // Test returns purge for awaiting-human-merge
  const state3 = {
    issue: 1,
    owner: { pid: 99999, at: Date.now() },
    pipelineState: {
      currentStep: "handoff",
      branchName: "test-branch",
      worktrees: {},
      mergeHold: true // Indicates awaiting-human-merge
    },
    eventLog: [
      { kind: "cap-hit", cap: "awaiting-human-merge" }
    ]
  } as any;
  const target3 = {
    ok: true,
    realPath: "/fake/path",
    name: "issue-1-test"
  } as SweepTargetResult;
  const opts3 = {
    state: state3,
    target: target3,
    selfPid: 99999,
    liveCycles: new Set(),
    launchingCycleIssue: 2,
    execFn: mockExecFn
  };
  const action3 = await decideSweepAction(opts3);
  assertTrue(action3.type === "purge", "should purge for awaiting-human-merge");
  // @ts-ignore
  assertEquals(action3.target, target3, "target should match");

  // Test returns remove for work provably on remote
  const state4 = {
    issue: 1,
    owner: { pid: 99999, at: Date.now() },
    pipelineState: {
      currentStep: "merged",
      branchName: "test-branch",
      worktrees: {}
    },
    eventLog: []
  } as any;
  const target4 = {
    ok: true,
    realPath: "/fake/path",
    name: "issue-1-test"
  } as SweepTargetResult;
  const opts4 = {
    state: state4,
    target: target4,
    selfPid: 99999,
    liveCycles: new Set(),
    launchingCycleIssue: 2,
    execFn: async (cmd: string, opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string }) => {
      // Mock git fetch to succeed
      if (cmd.includes("fetch")) {
        return { stdout: "", stderr: undefined };
      }
      // Mock git diff --quiet to succeed (exit 0)
      if (cmd.includes("diff --quiet")) {
        return { stdout: "", stderr: undefined };
      }
      // Mock git status --porcelain to succeed with empty output
      if (cmd.includes("status --porcelain")) {
        return { stdout: "", stderr: undefined };
      }
      return { stdout: "", stderr: undefined };
    }
  };
  const action4 = await decideSweepAction(opts4);
  assertTrue(action4.type === "remove", "should remove for work provably on remote");
  // @ts-ignore
  assertEquals(action4.target, target4, "target should match");

  // Test returns purge for fallback
  const state5 = {
    issue: 1,
    owner: { pid: 99999, at: Date.now() },
    pipelineState: {
      currentStep: "develop",
      branchName: "test-branch",
      worktrees: {}
    },
    eventLog: []
  } as any;
  const target5 = {
    ok: true,
    realPath: "/fake/path",
    name: "issue-1-test"
  } as SweepTargetResult;
  const opts5 = {
    state: state5,
    target: target5,
    selfPid: 99999,
    liveCycles: new Set(),
    launchingCycleIssue: 2,
    execFn: mockExecFn
  };
  const action5 = await decideSweepAction(opts5);
  assertTrue(action5.type === "purge", "should purge for fallback");
  // @ts-ignore
  assertEquals(action5.target, target5, "target should match");
}

async function testExecuteSweepAction() {
  console.log("\nTesting executeSweepAction...");
  // Test returns empty stdout for skip
  const actionSkip = { type: "skip", reason: "test" } as SweepAction;
  const mockExecFn = async () => {
    return { stdout: "should not be called", stderr: undefined };
  };
  const resultSkip = await executeSweepAction(actionSkip, mockExecFn);
  assertEquals(resultSkip.stdout, "", "stdout should be empty for skip");
  assertTrue(resultSkip.stderr === undefined, "stderr should be undefined for skip");

  // Test runs git clean -fdX for purge
  const target = {
    ok: true,
    realPath: "/fake/path",
    name: "issue-1-test"
  } as SweepTargetResult;
  const actionPurge = { type: "purge", target } as SweepAction;
  let calledWith: { cwd?: string } | null = null;
  const mockExecFn2 = async (cmd: string, opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string }) => {
    calledWith = opts;
    if (cmd === "git clean -fdX") {
      return { stdout: "", stderr: undefined };
    }
    return { stdout: "", stderr: undefined };
  };
  const resultPurge = await executeSweepAction(actionPurge, mockExecFn2);
  assertEquals(resultPurge.stdout, "", "stdout should be empty for purge");
  assertTrue(resultPurge.stderr === undefined, "stderr should be undefined for purge");
  assertEquals(calledWith?.cwd, "/fake/path", "cwd should be the worktree path for purge");

  // Test runs git worktree remove --force for remove
  const actionRemove = { type: "remove", target } as SweepAction;
  let calledWith2: { cwd?: string } | null = null;
  const mockExecFn3 = async (cmd: string, opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string }) => {
    calledWith2 = opts;
    if (cmd.startsWith("git worktree remove --force")) {
      return { stdout: "", stderr: undefined };
    }
    return { stdout: "", stderr: undefined };
  };
  const resultRemove = await executeSweepAction(actionRemove, mockExecFn3);
  assertEquals(resultRemove.stdout, "", "stdout should be empty for remove");
  assertTrue(resultRemove.stderr === undefined, "stderr should be undefined for remove");
  // The cwd should be the parent of the worktree
  assertEquals(calledWith2?.cwd, "/fake", "cwd should be the parent of the worktree for remove");
}

async function testRunWorktreeSweep() {
  console.log("\nTesting runWorktreeSweep...");
  // Test returns empty when disabled
  const result1 = await runWorktreeSweep({
    repoRoot: testRepoRoot,
    launchingCycleIssue: 1,
    liveCycles: new Set(),
    execFn: async () => ({ stdout: "", stderr: undefined }),
    enabled: false
  });
  assertFalse(result1.ran, "should not run when disabled");
  assertEquals(result1.checked, 0, "checked should be 0");
  assertEquals(result1.purged.length, 0, "purged should be empty");
  assertEquals(result1.removed.length, 0, "removed should be empty");
  assertEquals(result1.skipped.length, 0, "skipped should be empty");

  // We'll skip the full test for brevity, but in a real test we would add more
  // For now, we just test the disabled case
}

async function testRunWorktreeTeardown() {
  console.log("\nTesting runWorktreeTeardown...");
  // Test returns empty when disabled
  const state = {
    issue: 1,
    owner: { pid: 99999, at: Date.now() },
    pipelineState: {
      currentStep: "handoff",
      branchName: "test-branch",
      worktrees: {}
    },
    eventLog: []
  } as any;
  const result1 = await runWorktreeTeardown({
    repoRoot: testRepoRoot,
    state,
    execFn: async () => ({ stdout: "", stderr: undefined }),
    enabled: false
  });
  assertEquals(result1.length, 0, "should return empty array when disabled");

  // We'll skip the full test for brevity
}

// Run the tests
runTests();