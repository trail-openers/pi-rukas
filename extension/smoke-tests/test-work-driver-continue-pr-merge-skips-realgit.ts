#!/usr/bin/env bun
/**
 * #1468 — the driver's own commits never finish a continued PR's merge.
 *
 * A conflicted `--continue-pr` merge is left in progress for the developer.
 * The safety net and the cap-kill checkpoint both stage and commit on the
 * driver's behalf; on a worktree with MERGE_HEAD they would commit the
 * conflict markers as the merge commit. Both skip it, with a note.
 *
 * Real git repos in temp dirs; no dispatches.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { checkpointCapedDispatch } from "../src/work-driver-cap-checkpoint.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { safetyNetWorktree } from "../src/work-driver-safety-net.ts";
import { initialState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(dir: string, body: string, msg: string): string {
  writeFileSync(path.join(dir, "shared.txt"), body);
  git(dir, "add", "shared.txt");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

/** A worktree at the PR head P with a conflicting main merged in, left mid-merge. */
function midMerge(): { root: string; wt: string; P: string } {
  const root = mkdtempSync(path.join(tmpdir(), "continue-skip-"));
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  commit(root, "one\n", "base");
  git(root, "checkout", "-q", "-b", "pr");
  const P = commit(root, "pr\n", "feat: the PR");
  git(root, "checkout", "-q", "main");
  const M = commit(root, "main\n", "chore: main");
  const wt = path.join(root, ".worktrees", "issue-1468-default");
  git(root, "worktree", "add", "-q", "--detach", wt, P);
  try {
    git(wt, "merge", "--no-ff", "--no-edit", M);
  } catch {
    // The conflict is the point.
  }
  if (!readFileSync(path.join(wt, "shared.txt"), "utf8").includes("<<<<<<<")) {
    throw new Error("fixture: expected conflict markers");
  }
  return { root, wt, P };
}

// ------------------------------------------------------------ safety net
{
  const { root, wt, P } = midMerge();
  try {
    const notes: string[] = [];
    // effectiveBase = P, so without the skip the tree reads "dirty, no commits ahead".
    const event = await safetyNetWorktree("default", root, wt, P, execp, notes);
    assert(event === undefined, "safety net: no commit event on a MERGE_HEAD worktree");
    assert(git(wt, "rev-parse", "HEAD") === P, "safety net: HEAD is still the PR head");
    assert(
      notes.some((n) => n.includes("MERGE_HEAD")),
      `safety net: the skip is noted (got: ${notes.join("; ")})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------------------------------------- cap checkpoint
{
  const { root, wt, P } = midMerge();
  try {
    let s = initialState(1468, Date.now());
    s = {
      ...s,
      pipelineState: { ...s.pipelineState, currentStep: "develop", worktrees: { default: wt } },
      eventLog: [
        ...s.eventLog,
        {
          kind: "dispatch-failed",
          step: "develop",
          role: "developer",
          jobId: "j1",
          label: "developer",
          ms: 1000,
          at: Date.now(),
          exitCode: 143,
          killCause: "loop",
          errorTail: "killed by pi-rukas (loop)",
        },
      ],
    };
    await writeState(root, s);
    const ctx = {
      host: { sendUserMessage: () => {} },
      repoRoot: root,
      issue: 1468,
      checkpointExecFn: async () => ({ stdout: "", stderr: "" }),
    } as unknown as DriverContext;
    const out = await checkpointCapedDispatch(ctx, s, "develop");
    const cps = out.pipelineState.capedPartialState;
    assert(cps?.tree !== "committed", `cap checkpoint: nothing committed (tree=${cps?.tree})`);
    assert(git(wt, "rev-parse", "HEAD") === P, "cap checkpoint: HEAD is still the PR head");
    const mergeHead = path.resolve(wt, git(wt, "rev-parse", "--git-path", "MERGE_HEAD"));
    assert(existsSync(mergeHead), "cap checkpoint: the merge is left open");
    const status = cps?.statusFile ? readFileSync(cps.statusFile, "utf8") : "";
    assert(status.includes("MERGE_HEAD"), "cap checkpoint: the status file notes the skip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
