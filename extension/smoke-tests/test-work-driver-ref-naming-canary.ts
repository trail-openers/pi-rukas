#!/usr/bin/env bun
/**
 * #451 — load-bearing canary: verification gates must fail when the branch
 * has zero commits, even if the repo root is checked out on mainline.
 *
 * The golden fixture: a real git repo with main checked out at the root,
 * a feature branch with zero commits ahead of main. `verifyStepOutcome` at
 * commit-pr MUST fail (not pass) in this scenario. If the gate is reverted
 * to bare `..HEAD`, the root is on main, so `origin/main..HEAD` =
 * `origin/main..main` = 0, and the gate passes unconditionally — the worst
 * possible failure mode.
 *
 * Also tests `verifyConsolidation` for the same shape: repo root on
 * mainline, multi-workstream state, feature branch with no commits. The
 * gate must report missing workstreams (or at minimum not report
 * `filesPresent` with content).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyConsolidation, verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// Fixture: real git repo, root on MAINLINE, feature branch with zero commits.
// ---------------------------------------------------------------------------

async function setupFixture(): Promise<{ root: string; branch: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "451-ref-naming-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });

  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await execFileP("git", ["config", "user.email", "canary@example.com"], { cwd: repo });
  await execFileP("git", ["config", "user.name", "Canary"], { cwd: repo });

  // Initial commit on main
  writeFileSync(path.join(repo, "file.txt"), "base\n");
  await execFileP("git", ["add", "file.txt"], { cwd: repo });
  await execFileP("git", ["commit", "-q", "-m", "base"], { cwd: repo });

  // Create a bare "origin" remote so `origin/main` resolves.
  const origin = path.join(root, "origin.git");
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["remote", "add", "origin", origin], { cwd: repo });
  await execFileP("git", ["push", "-q", "origin", "main"], { cwd: repo });

  // Feature branch with ZERO commits ahead of main (just a branch point).
  const branch = "feature/issue-451-canary";
  await execFileP("git", ["branch", branch], { cwd: repo });
  await execFileP("git", ["push", "-q", "origin", branch], { cwd: repo });

  // Root stays checked out on main (the post-epic shape).
  const headBranch = (
    await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo })
  ).stdout.trim();
  if (headBranch !== "main") {
    await execFileP("git", ["checkout", "-q", "main"], { cwd: repo });
  }

  return { root: repo, branch };
}

// ---------------------------------------------------------------------------
// 1. verifyStepOutcome at commit-pr MUST fail with zero-commit branch
// ---------------------------------------------------------------------------

async function testCommitPrGate() {
  const { root, branch } = await setupFixture();
  try {
    let s = initialState(451, 452);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: branch,
        prNumber: 999,
        worktrees: { default: root },
      },
    };

    const ctx: DriverContext = {
      pi: {} as ExtensionAPI,
      repoRoot: root,
      issue: 451,
      issueBodyFetcherFn: () => ({ stdout: "canary test" }),
      // Use real exec — we want git commands to run against the fixture.
      verifyExecFn: async (
        cmd: string,
        opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
      ) => {
        const { stdout, stderr } = await execFileP("/bin/sh", ["-c", cmd], {
          cwd: opts?.cwd,
          timeout: opts?.timeout,
          maxBuffer: opts?.maxBuffer ?? 64 * 1024,
        });
        if (stderr.includes("fatal:")) throw new Error(stderr);
        return { stdout };
      },
    };

    const result = await verifyStepOutcome(ctx, s, "commit-pr");
    // The gate should FAIL: the branch has zero commits ahead of main.
    assert(
      !result.ok,
      "#451: verifyStepOutcome(commit-pr) FAILS when branch has zero commits (root on mainline)",
    );
    assert(
      result.failures.some((f) => /zero commits/.test(f)),
      "#451: failure message mentions zero commits",
    );

    console.log(`  (repo root on: main, branch: ${branch}, commits ahead: 0)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. verifyStepOutcome at commit-pr PASSES when branch has commits
// ---------------------------------------------------------------------------

async function testCommitPrGatePasses() {
  const root = mkdtempSync(path.join(tmpdir(), "451-ref-naming-pass-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });

  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await execFileP("git", ["config", "user.email", "canary@example.com"], { cwd: repo });
  await execFileP("git", ["config", "user.name", "Canary"], { cwd: repo });
  writeFileSync(path.join(repo, "file.txt"), "base\n");
  await execFileP("git", ["add", "file.txt"], { cwd: repo });
  await execFileP("git", ["commit", "-q", "-m", "base"], { cwd: repo });

  const origin = path.join(root, "origin.git");
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["remote", "add", "origin", origin], { cwd: repo });
  await execFileP("git", ["push", "-q", "origin", "main"], { cwd: repo });

  // Feature branch WITH a commit ahead.
  const branch = "feature/issue-451-pass";
  await execFileP("git", ["checkout", "-q", "-b", branch], { cwd: repo });
  writeFileSync(path.join(repo, "new.txt"), "added\n");
  await execFileP("git", ["add", "new.txt"], { cwd: repo });
  await execFileP("git", ["commit", "-q", "-m", "add new file"], { cwd: repo });
  await execFileP("git", ["push", "-q", "origin", branch], { cwd: repo });

  // Switch root back to main (the post-epic shape).
  await execFileP("git", ["checkout", "-q", "main"], { cwd: repo });

  try {
    let s = initialState(453, 454);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: branch,
        prNumber: 998,
        worktrees: { default: repo },
      },
    };

    const ctx: DriverContext = {
      pi: {} as ExtensionAPI,
      repoRoot: repo,
      issue: 453,
      issueBodyFetcherFn: () => ({ stdout: "canary pass test" }),
      verifyExecFn: async (
        cmd: string,
        opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
      ) => {
        const { stdout, stderr } = await execFileP("/bin/sh", ["-c", cmd], {
          cwd: opts?.cwd,
          timeout: opts?.timeout,
          maxBuffer: opts?.maxBuffer ?? 64 * 1024,
        });
        if (stderr.includes("fatal:")) throw new Error(stderr);
        return { stdout };
      },
    };

    const result = await verifyStepOutcome(ctx, s, "commit-pr");
    // The commit-count gate should NOT fail (branch has 1 commit ahead).
    // The PR gate will fail (no real PR), but the zero-commits failure
    // must NOT be present.
    assert(
      !result.failures.some((f) => /zero commits/.test(f)),
      "#451: verifyStepOutcome(commit-pr) does NOT report zero commits when branch has commits (root on mainline)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. verifyConsolidation with zero-commit branch (root on mainline)
// ---------------------------------------------------------------------------

async function testConsolidationZeroCommits() {
  const { root, branch } = await setupFixture();
  try {
    let s = initialState(455, 456);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: branch,
        worktrees: { default: root },
        workstreams: {
          default: {
            id: "default",
            scope: "task",
            paths: ["extension/src/foo.ts"],
            outOfScope: [],
          },
          "task-b": {
            id: "task-b",
            scope: "task b",
            paths: ["extension/src/bar.ts"],
            outOfScope: [],
          },
        },
      },
    };

    const ctx: DriverContext = {
      pi: {} as ExtensionAPI,
      repoRoot: root,
      issue: 455,
      issueBodyFetcherFn: () => ({ stdout: "consolidation test" }),
    };

    const result = await verifyConsolidation(ctx, s);
    // With zero commits ahead, filesPresent must be empty.
    assert(
      result.filesPresent.length === 0,
      "#451: verifyConsolidation reports no files when branch has zero commits (root on mainline)",
    );
    // All workstreams with paths should be reported as missing/uncovered.
    assert(
      result.missing.length === 2,
      `#451: verifyConsolidation reports all 2 workstreams missing (got ${result.missing.length})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. verifyConsolidation with commits on the branch PASSES
// ---------------------------------------------------------------------------

async function testConsolidationWithCommits() {
  const root = mkdtempSync(path.join(tmpdir(), "451-ref-naming-consol-pass-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });

  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await execFileP("git", ["config", "user.email", "canary@example.com"], { cwd: repo });
  await execFileP("git", ["config", "user.name", "Canary"], { cwd: repo });
  mkdirSync(path.join(repo, "extension/src"), { recursive: true });
  writeFileSync(path.join(repo, "extension/src/foo.ts"), "export const foo = 1;\n");
  writeFileSync(path.join(repo, "extension/src/bar.ts"), "export const bar = 2;\n");
  await execFileP("git", ["add", "."], { cwd: repo });
  await execFileP("git", ["commit", "-q", "-m", "base"], { cwd: repo });

  const origin = path.join(root, "origin.git");
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["remote", "add", "origin", origin], { cwd: repo });
  await execFileP("git", ["push", "-q", "origin", "main"], { cwd: repo });

  // Feature branch with commits touching both files.
  const branch = "feature/issue-451-consol-pass";
  await execFileP("git", ["checkout", "-q", "-b", branch], { cwd: repo });
  writeFileSync(path.join(repo, "extension/src/foo.ts"), "export const foo = 2;\n");
  writeFileSync(path.join(repo, "extension/src/bar.ts"), "export const bar = 3;\n");
  await execFileP("git", ["add", "."], { cwd: repo });
  await execFileP("git", ["commit", "-q", "-m", "change both"], { cwd: repo });
  await execFileP("git", ["push", "-q", "origin", branch], { cwd: repo });

  // Switch root back to main.
  await execFileP("git", ["checkout", "-q", "main"], { cwd: repo });

  try {
    let s = initialState(457, 458);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: branch,
        worktrees: { default: repo },
        workstreams: {
          default: {
            id: "default",
            scope: "task",
            paths: ["extension/src/foo.ts"],
            outOfScope: [],
          },
          "task-b": {
            id: "task-b",
            scope: "task b",
            paths: ["extension/src/bar.ts"],
            outOfScope: [],
          },
        },
      },
    };

    const ctx: DriverContext = {
      pi: {} as ExtensionAPI,
      repoRoot: repo,
      issue: 457,
      issueBodyFetcherFn: () => ({ stdout: "consolidation pass test" }),
    };

    const result = await verifyConsolidation(ctx, s);
    // With commits on the branch, both files should be present and no
    // workstream should be missing.
    assert(
      result.filesPresent.length >= 2,
      `#451: verifyConsolidation sees committed files (got ${result.filesPresent.length})`,
    );
    assert(
      result.missing.length === 0,
      `#451: verifyConsolidation reports no missing workstreams when branch has commits (got ${result.missing.length})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

await testCommitPrGate();
await testCommitPrGatePasses();
await testConsolidationZeroCommits();
await testConsolidationWithCommits();

console.log(`\nexit ${exit}`);
process.exit(exit);
