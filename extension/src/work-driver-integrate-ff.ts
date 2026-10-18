/**
 * work-driver-integrate-ff — #1468: integrate step 3 for `--continue-pr`.
 * The worktree HEAD is the PR head with the mainline merged in, so the
 * branch is fast-forwarded to it. A cherry-pick would fail on the merge
 * commit and drop its second parent.
 */

import { trace } from "./trace.ts";
import type { OrchestratedCherryPickResult } from "./work-driver-cherry-pick.ts";
import { stagePorcelainPaths } from "./work-driver-stage.ts";
import { type ExecFn, gitErrorDetail } from "./worktree.ts";

/**
 * Commit each worktree's uncommitted work onto its HEAD, then
 * `merge --ff-only` that HEAD at repoRoot; a refusal throws. The commit does
 * what the patch fallback does for a cherry-pick: a developer leaves edits
 * uncommitted, and a fast-forward alone would push the branch without them.
 */
export async function fastForwardOnto(
  execFn: ExecFn,
  repoRoot: string,
  ids: string[],
  worktrees: Record<string, string>,
  commit: { title: string; body: string; exempt?: readonly string[] },
): Promise<OrchestratedCherryPickResult> {
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) throw new Error(`worktree '${id}' has no path`);
    if ((await stagePorcelainPaths(execFn, wt, commit.exempt)) > 0) {
      await execFn("git", { argv: ["commit", "-m", commit.title, "-m", commit.body], cwd: wt });
    }
    const head = (await execFn("git", { argv: ["rev-parse", "HEAD"], cwd: wt })).stdout.trim();
    await execFn("git", { argv: ["merge", "--ff-only", head], cwd: repoRoot });
  }
  return {
    cherryApplied: ids,
    cherryPickShas: {},
    skippedAlreadyOnBranch: [],
    patchApplied: [],
    noDiff: {},
    emptyWorkstreams: [],
    hadNewCommits: true,
  };
}

/**
 * Put the local branch back to `from` after a fast-forward that was not
 * pushed, so a re-entry compares the worktree with what origin holds and
 * finds its work again. A compare-and-swap: a branch something else moved,
 * or one repoRoot has checked out, is left alone. The worktrees keep their
 * commits.
 */
export async function rewindFastForward(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
  from: string,
): Promise<void> {
  const ref = `refs/heads/${branchName}`;
  try {
    const cur = (
      await execFn("git", { argv: ["rev-parse", "-q", "--verify", ref], cwd: repoRoot })
    ).stdout.trim();
    if (cur === from) return;
    const held = await execFn("git", { argv: ["symbolic-ref", "-q", "HEAD"], cwd: repoRoot })
      .then((r) => r.stdout.trim())
      .catch(() => "");
    if (held === ref) {
      trace(`work-driver: integrate — not rewinding ${branchName}, repoRoot has it checked out`);
      return;
    }
    await execFn("git", { argv: ["update-ref", ref, from, cur], cwd: repoRoot });
    trace(`work-driver: integrate — rewound unpushed ${branchName} to ${from.slice(0, 8)}`);
  } catch (err) {
    trace(
      `work-driver: integrate — could not rewind ${branchName}: ${gitErrorDetail(err).slice(0, 200)}`,
    );
  }
}
