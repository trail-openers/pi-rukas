#!/usr/bin/env bun
/**
 * #818 — resume/re-entry stability of the branch step.
 *
 * A state file that already recorded a `branchName` (a cycle re-entered at
 * the branch step after a crash, or one whose branch step previously fell
 * back to ops) MUST keep the RECORDED name. The driver never re-runs the
 * branch step on the happy path (nextStep's linear table routes plan → branch
 * exactly once), so a recorded branchName at runBranch means a resumed cycle.
 *
 * Pre-#818, runBranch unconditionally called mechanizedBranchSetup, which
 * re-derived the slug from `cachedIssueTitle` — and fixing cachedIssueTitle
 * to also read the bare-title explore artifact (the #818 root-cause fix)
 * changes what the slug derives from, so a resumed cycle would point
 * commit-pr's re-entry guard and the PR at a branch the work was never on.
 *
 * The fix: when `state.pipelineState.branchName` is already set, skip the
 * mechanized setup entirely and fall through to the ops dispatch, which
 * records git's ACTUAL branch (the same name) and never invents a new slug.
 *
 * This test asserts:
 *   1. A state file with a recorded branchName does NOT trigger a fresh
 *      mechanizedBranchSetup (no `git worktree add` calls for the branch
 *      step; the branch step routes to ops dispatch).
 *   2. The recorded branchName survives the step (pipelineState.branchName
 *      is the same value, not a re-derived slug).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type readState, writeState } from "../src/workflow-state.ts";

import { makeFakePi, mkResult } from "./test-mechanized-commit-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";

const RECORD = "feature/issue-818-the-recorded-branch";

async function runResumeScenario(
  dir: string,
  issue: number,
  opts: { recordedBranch?: string },
): Promise<{ calls: string[]; after: Awaited<ReturnType<typeof readState>> }> {
  await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
    recursive: true,
  });
  const calls: string[] = [];
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    calls.push(cmd);
    if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
    if (cmd === "git rev-parse --abbrev-ref HEAD")
      return { stdout: `${opts.recordedBranch ?? "main"}\n` };
    if (cmd.startsWith("git rev-parse ")) return { stdout: "base123\n" };
    if (cmd.startsWith("git fetch origin")) return { stdout: "" };
    if (cmd.startsWith("git worktree add")) return { stdout: "" };
    if (cmd.startsWith("git status --porcelain")) return { stdout: "" };
    if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
    if (cmd.startsWith("git diff --name-only origin/")) return { stdout: "" };
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
    if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
    if (cmd.startsWith("gh pr list")) return { stdout: "[]" };
    return { stdout: "" };
  };

  const baseState = {
    issue,
    schemaVersion: 1,
    resumable: false,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "running",
      currentStep: "branch",
      lastCompletedStep: "plan",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: opts.recordedBranch,
      baseSha: "base123",
      worktrees: { default: path.join(dir, ".worktrees", `issue-${issue}-default`) },
      issueBodyArtifact: path.join(dir, "tmp", `issue-${issue}`, "issue-body.txt"),
    },
    eventLog: [],
  } as unknown as import("../src/workflow-state.ts").WorkState;
  await writeState(dir, baseState);

  const issueBodyFetcherFn = async (_n: number, _cwd: string) => ({
    stdout: "chore: the recorded branch must survive resume\n\nbody",
  });

  const dispatchFn: NonNullable<DriverContext["dispatchFn"]> = async (
    _pi: unknown,
    spec: { role: string; prompt: string },
    dOpts?: { label?: string },
  ) => {
    const label = dOpts?.label ?? spec.role;
    if (label === "ops") {
      return mkResult({
        role: "ops",
        text: [
          `branch: ${opts.recordedBranch ?? "main"}`,
          "",
          "## Worktrees",
          "",
          `- default: ${path.join(dir, ".worktrees", `issue-${issue}-default`)}`,
        ].join("\n"),
      });
    }
    throw new Error(`unexpected dispatch: ${label}`);
  };

  const ctx: DriverContext = {
    pi: makeFakePi().pi,
    repoRoot: dir,
    issue,
    issueBodyFetcherFn,
    verifyExecFn: exec,
    dispatchFn,
    issues: [issue],
  };

  const result = await runBranch(ctx, baseState, Date.now()).catch(() => baseState);
  return { calls, after: result };
}

{
  // Case 1: a resumed cycle with a recorded branchName keeps it.
  const dir1 = mkdtempSync(path.join(tmpdir(), "issue818-resume-1-"));
  try {
    const { calls, after } = await runResumeScenario(dir1, 818, {
      recordedBranch: RECORD,
    });
    // The branch step must NOT have created a fresh worktree via
    // mechanizedBranchSetup — the recorded name is used, not a re-derived
    // slug. (The worktree already exists from the prior cycle.)
    const worktreeAdds = calls.filter((c) => c.startsWith("git worktree add"));
    assert(
      worktreeAdds.length === 0,
      `no fresh mechanized branch setup on resume (got ${worktreeAdds.length} worktree adds)`,
    );
    assert(
      after?.pipelineState.branchName === RECORD,
      `the recorded branchName survives the step (got ${JSON.stringify(after?.pipelineState.branchName)}, want ${JSON.stringify(RECORD)})`,
    );
  } finally {
    rmSync(dir1, { recursive: true, force: true });
  }

  // Case 2: a fresh cycle (no recorded branchName) does NOT skip the
  // mechanized path. The fake exec is minimal (no `git rev-parse
  // refs/remotes/origin/main` handler), so the mechanized setup may throw
  // and fall back to ops — but the key assertion is that the mechanism is
  // INVOCKED: `git worktree add` or `git fetch origin` is attempted (the
  // mechanized path runs). In contrast, case 1 (resume) runs ZERO such
  // commands because the recorded branchName short-circuits the mechanized
  // path entirely.
  const dir2 = mkdtempSync(path.join(tmpdir(), "issue818-fresh-2-"));
  try {
    const { calls } = await runResumeScenario(dir2, 819, { recordedBranch: undefined });
    const mechanizedCmds = calls.filter(
      (c) => c.startsWith("git worktree add") || c.startsWith("git fetch origin"),
    );
    assert(
      mechanizedCmds.length > 0,
      `a fresh cycle attempts mechanized branch setup (got ${mechanizedCmds.length} mechanized commands)`,
    );
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
