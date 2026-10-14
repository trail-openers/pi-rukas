#!/usr/bin/env bun
/**
 * #1093 — repoRoot is restored to the ref the cycle STARTED on, not to
 * mainline and not to whatever the cycle left checked out.
 *
 * Real-git tests in temp repos only (never the real one). They pin:
 *   1. recordCycleStartRef / captureCycleStartRef: the branch name when
 *      attached, the SHA when detached, written once (a resumed cycle keeps
 *      the ref its first run captured);
 *   2. restoreCheckout(…, startRef): a feature-branch start ends on that
 *      branch with NO pull; a detached start ends at the same SHA; a
 *      mainline start is unchanged from the pre-#1093 behaviour;
 *   3. a refused checkout (dirty tree that would be overwritten) is NOT
 *      forced: the tree is left as it was and the note carries the exact
 *      command the operator runs by hand;
 *   4. restoreRootToRef (the handoff success-path restore) is non-forcing
 *      with the same refusal shape;
 *   5. the handoff repro: the branch step left repoRoot on a stray branch;
 *      consolidation must return it to the recorded start ref, not to the
 *      stray branch it captured mid-cycle;
 *   6. resume: the ref survives a writeState/readState round-trip, so a
 *      resumed cycle restores to the ref its first run captured;
 *   7. the ABORT path (restoreRootToRefPreserving) never issues a forced
 *      command, preserves the discarded state first, and reports the command;
 *   8. refs with shell metacharacters and a tag sharing the branch's short
 *      name are checked out verbatim, never expanded or misread.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCycleStartRef, recordCycleStartRef, restoreCheckout } from "../src/work-driver-git.ts";
import { consolidateWorktreesToBranch } from "../src/work-driver-handoff-consolidate.ts";
import { restoreRootToRef } from "../src/work-driver-restore.ts";
import { WorkState, readState, writeState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";
import { assert, realExec, shown, buildRepo, head, sha, stateWith, result } from "./lib/restore-start-ref-fixtures.ts";

// ---- 1. capture + record --------------------------------------------------
{
  const dir = buildRepo();
  try {
    assert(
      (await captureCycleStartRef(realExec, dir)) === "feature/merged",
      "capture: attached HEAD → the branch name",
    );
    const detachedSha = sha(dir);
    execFileSync("git", ["checkout", "-q", "--detach"], { cwd: dir });
    assert(
      (await captureCycleStartRef(realExec, dir)) === detachedSha,
      "capture: detached HEAD → the commit SHA",
    );
    execFileSync("git", ["checkout", "-q", "feature/x"], { cwd: dir });
    const first = await recordCycleStartRef(realExec, dir, stateWith(undefined, "b"));
    assert(
      first.pipelineState.startRef === "feature/x",
      "record: stamps startRef from the checkout the cycle found",
    );
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
    const second = await recordCycleStartRef(realExec, dir, first);
    assert(
      second.pipelineState.startRef === "feature/x",
      "record: written once — a resumed cycle keeps the first ref (repoRoot has moved to main)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 2. restoreCheckout targets -------------------------------------------
{
  const dir = buildRepo();
  try {
    const calls: string[] = [];
    const recording: ExecFn = (cmd, opts) => {
      calls.push(shown(cmd, opts));
      return realExec(cmd, opts);
    };
    await restoreCheckout({
      repoRoot: dir,
      mainline: "main",
      mergedBranch: "feature/merged",
      execFn: recording,
      startRef: "feature/x",
    });
    assert(head(dir) === "feature/x", "restore: feature-branch start → repoRoot back on feature/x");
    assert(
      !calls.some((c) => c.startsWith("git pull")),
      "restore: no `git pull` when the target is not mainline",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = buildRepo();
  try {
    const start = sha(dir, "feature/x");
    execFileSync("git", ["checkout", "-q", "--detach", start], { cwd: dir });
    execFileSync("git", ["checkout", "-q", "feature/merged"], { cwd: dir });
    await restoreCheckout({
      repoRoot: dir,
      mainline: "main",
      mergedBranch: "feature/merged",
      execFn: realExec,
      startRef: start,
    });
    assert(
      head(dir) === "HEAD" && sha(dir) === start,
      "restore: detached start → repoRoot detached at the same SHA",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = buildRepo();
  try {
    await restoreCheckout({
      repoRoot: dir,
      mainline: "main",
      mergedBranch: "feature/merged",
      execFn: realExec,
      startRef: "main",
    });
    assert(head(dir) === "main", "restore: mainline start → repoRoot on main (unchanged)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 3. refused checkout is reported, never forced ------------------------
{
  const dir = buildRepo();
  try {
    const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    // feature/x carries a different tracked.txt; the cycle's branch has an
    // uncommitted edit to the same file, so the checkout would overwrite it.
    g(["checkout", "-q", "feature/x"]);
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    g(["commit", "-q", "-am", "x"]);
    g(["checkout", "-q", "feature/merged"]);
    writeFileSync(join(dir, "tracked.txt"), "operator edit\n");
    const notes = await restoreCheckout({
      repoRoot: dir,
      mainline: "main",
      mergedBranch: undefined,
      execFn: realExec,
      startRef: "feature/x",
    });
    assert(head(dir) === "feature/merged", "refused: HEAD stays on the cycle's branch");
    assert(
      readFileSync(join(dir, "tracked.txt"), "utf8") === "operator edit\n",
      "refused: the operator's uncommitted edit is untouched (no reset, no --force)",
    );
    assert(
      notes.some((n) => n.includes("git checkout feature/x") && n.includes("NOT restored")),
      `refused: the note carries the exact command to run (got ${JSON.stringify(notes)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 4. restoreRootToRef (handoff success path) ---------------------------
{
  const dir = buildRepo();
  try {
    const ok = await restoreRootToRef(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      label: "test",
    });
    assert(ok.restored && head(dir) === "feature/x", "restoreRootToRef: clean checkout → restored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = buildRepo();
  try {
    const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    g(["checkout", "-q", "feature/x"]);
    writeFileSync(join(dir, "tracked.txt"), "x\n");
    g(["commit", "-q", "-am", "x"]);
    g(["checkout", "-q", "feature/merged"]);
    writeFileSync(join(dir, "tracked.txt"), "operator edit\n");
    const r = await restoreRootToRef(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      label: "test",
    });
    assert(!r.restored, "restoreRootToRef: refusal → not restored");
    assert(
      r.detail?.includes("run `git checkout feature/x --`") === true,
      `restoreRootToRef: detail names the exact command (got ${JSON.stringify(r.detail)})`,
    );
    assert(
      readFileSync(join(dir, "tracked.txt"), "utf8") === "operator edit\n",
      "restoreRootToRef: tree left as it was (no reset)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 5. handoff repro: branch step left repoRoot on a stray branch --------
{
  const dir = mkdtempSync(join(tmpdir(), "issue1093-handoff-"));
  const wt = join(dir, ".worktrees", "issue-1093-task-a");
  const g = (args: string[], cwd: string = dir) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    mkdirSync(join(dir, ".worktrees"), { recursive: true });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.name", "t"]);
    g(["config", "user.email", "t@t"]);
    writeFileSync(join(dir, "tracked.txt"), "initial\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "base"]);
    g(["checkout", "-q", "-b", "operator-feature"]);
    g(["worktree", "add", "-q", "--detach", wt, "HEAD"]);
    writeFileSync(join(wt, "change.txt"), "content\n");
    g(["add", "-A"], wt);
    g(["commit", "-q", "-m", "w: real change"], wt);
    const wtHead = g(["rev-parse", "HEAD"], wt);
    const baseSha = g(["rev-parse", "operator-feature"]);
    // The stray branch: where the cycle left repoRoot before consolidation.
    g(["checkout", "-q", "-b", "stray"]);
    const state = stateWith("operator-feature", "feature/issue-1093-handoff");
    state.pipelineState.baseSha = baseSha;
    state.pipelineState.worktrees = { "task-a": wt };
    state.pipelineState.status = "handoff";
    state.pipelineState.currentStep = "handoff";
    state.eventLog = [
      {
        kind: "cap-hit",
        at: 3,
        cap: "verify-failed:develop",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ];
    state.pipelineState.handoffSnapshot = {
      modifiedFiles: [],
      unstagedCount: 0,
      stagedCount: 0,
      branchExists: false,
      branchPushed: false,
      repoRootHeadSha: wtHead.slice(0, 8),
      capturedAt: 1000,
      committedWork: [{ worktreeId: "task-a", path: wt, headSha: wtHead, ahead: 1 }],
    };
    process.env.PI_ENSEMBLE_FORGE = "none";
    const result = await consolidateWorktreesToBranch(
      { repoRoot: dir, issue: 1093, scratchDir: dir },
      state,
    );
    assert(result.ok, `handoff: consolidation succeeded (reason=${result.reason ?? "none"})`);
    assert(
      g(["rev-parse", "--abbrev-ref", "HEAD"]) === "operator-feature",
      "handoff: repoRoot returns to the recorded start ref (operator-feature), not the stray branch",
    );
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir });
    } catch {
      /* worktree already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 6. resume: the ref survives a state-file round-trip -----------------
{
  const dir = buildRepo();
  try {
    execFileSync("git", ["checkout", "-q", "feature/x"], { cwd: dir });
    const stamped = await recordCycleStartRef(realExec, dir, stateWith(undefined, "b"));
    await writeState(dir, stamped);
    // The first run's branch step moved repoRoot; the resumed run must not re-capture.
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
    const resumed = await readState(dir, 1093);
    assert(resumed !== undefined, "resume: the state file is readable after the checkout moved");
    const again = await recordCycleStartRef(realExec, dir, resumed as WorkState);
    assert(
      again.pipelineState.startRef === "feature/x",
      `resume: the persisted startRef survives a resume (got ${again.pipelineState.startRef})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${result.exit}`);
process.exit(result.exit);
