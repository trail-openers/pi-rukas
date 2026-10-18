/**
 * work-driver-integrate-ff — #1468: integrate step 3 for `--continue-pr`.
 * The worktree HEAD is the PR head with the mainline merged in, so the
 * branch is fast-forwarded to it. A cherry-pick would fail on the merge
 * commit and drop its second parent.
 */

import type { OrchestratedCherryPickResult } from "./work-driver-cherry-pick.ts";
import type { ExecFn } from "./worktree.ts";

/** `merge --ff-only` each worktree HEAD at repoRoot; a refusal throws. */
export async function fastForwardOnto(
  execFn: ExecFn,
  repoRoot: string,
  ids: string[],
  worktrees: Record<string, string>,
): Promise<OrchestratedCherryPickResult> {
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) throw new Error(`worktree '${id}' has no path`);
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
