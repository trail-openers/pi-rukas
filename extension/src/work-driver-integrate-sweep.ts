/**
 * work-driver-integrate-sweep — the followup mode's branch-holder sweep, split
 * from `work-driver-integrate.ts` (AGENTS.md §12's line cap).
 *
 * #654 — a clean worktree holding the target branch blocks
 * `git checkout <branch>` outright ("fatal: '<branch>' is already used by
 * worktree at '…'"); a dirty one must never be force-removed (the #475
 * convention) and throws `DirtyWorktreeError`. `sweepBranchHolders` runs under
 * `withIntegrationLock`, before the checkout.
 *
 * #1396 (six-lens round 3) — the sweep now REFUSES a `git worktree list` it
 * could not read: a hang on the 30 s bound is a rejection, and the old
 * `.catch(() => "")` turned one into "no holder", unblocking the very checkout
 * the sweep exists to protect. This module is where that refusal is given its
 * meaning, which is why it lives at the call site rather than inside the sweep:
 *
 *   - `repoRoot` not being a repository at all (`git: not a git repository`, or
 *     an `ENOENT` — a fixture path, a checkout that vanished mid-cycle) is
 *     "there is nothing here to hold the branch". The sweep is skipped and the
 *     checkout runs, reporting the real problem in git's own words — the
 *     pre-#1396 behaviour, and the right one: halting the whole integration
 *     because a non-repository has no worktree list is worse than the raw git
 *     error an operator can act on.
 *   - Anything else — a hang, a lock, a kill — propagates and halts. That is
 *     the direction this round flipped.
 */

import { trace } from "./trace.ts";
import { WorktreeScanError, gitErrorDetail, isMissingGit, sweepBranchHolders } from "./worktree.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * #1396 (round 3) — the integrate caller's "this root is not a repository"
 * test, used ONLY for the sweep refusal below.
 *
 * Kept separate from `isMissingGit` (which every other read uses, on the code
 * alone) because this is a caller-level judgement about ONE command's failure,
 * made where the text is git output the caller already reads: a non-repository
 * root has no holders by definition and no checkout to protect, and git's own
 * `git checkout` a few statements later says so in the reason the operator
 * sees. A hang, a lock, or a kill never matches and still halts the cycle.
 */
function isNotARepoError(err: unknown): boolean {
  if (isMissingGit(err)) return true;
  return /not a git repository/i.test(gitErrorDetail(err));
}

/**
 * Sweep the branch's clean holders before the followup checkout, degrading ONLY
 * over a repoRoot that is not a repository (see the module header). A dirty
 * holder's `DirtyWorktreeError` and an unreadable listing's
 * `WorktreeScanError` both propagate to `integrate()`'s catch, which plumbs
 * them into the halt reason.
 */
export async function sweepBeforeFollowupCheckout(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): Promise<void> {
  try {
    await sweepBranchHolders(execFn, repoRoot, branchName);
  } catch (err) {
    if (err instanceof WorktreeScanError && isNotARepoError(err)) {
      trace(
        `integrate: no worktree list to sweep at ${repoRoot} — it is not a git repository; proceeding to the checkout, which reports the real error`,
      );
      return;
    }
    throw err;
  }
}
