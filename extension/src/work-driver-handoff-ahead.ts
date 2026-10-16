/**
 * work-driver-handoff-ahead — how much committed work the cycle's worktrees
 * still carry, and whether any of it is missing from the feature branch.
 *
 * Split from `work-driver-handoff-consolidate.ts` (file-size gate): the
 * consolidate module owns MOVING work onto the branch; these two predicates
 * only READ state, and are consumed both by that module and directly by
 * `runHandoff` (the crash-resume dedupe guard), so they are the seam.
 */
import { readError } from "./work-driver-handoff-snapshot.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * How many local commits the worktrees carry past `baseSha`, and at which
 * worktree HEADs. `rev-list --count baseSha..HEAD` is the same predicate the
 * cherry-pick orchestrator uses to decide a worktree has commits to move, so
 * consolidation only runs when there is something to move. Returns
 * `{ total: 0 }` when there is no committed work to consolidate (or no base
 * SHA recorded) — the caller treats that as "nothing to do, keep the
 * existing snapshot". A count that could not be READ is reported in
 * `unreadable`, never folded into that zero.
 */
export async function countAheadOfBase(
  execFn: ExecFn,
  repoRoot: string,
  baseSha: string | undefined,
  worktrees: Record<string, string>,
): Promise<{ total: number; ahead: Record<string, number>; unreadable: string[] }> {
  if (!baseSha) return { total: 0, ahead: {}, unreadable: [] };
  const ahead: Record<string, number> = {};
  const unreadable: string[] = [];
  let total = 0;
  for (const [id, wt] of Object.entries(worktrees)) {
    try {
      const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(baseSha)}..HEAD`, {
        cwd: wt,
        maxBuffer: 64 * 1024,
      });
      const n = Number.parseInt(stdout.trim(), 10);
      if (Number.isFinite(n) && n > 0) {
        ahead[id] = n;
        total += n;
      }
    } catch (err) {
      // Unreadable worktree (deleted on disk, git could not run) — nothing
      // to move from here, but NOT proof it holds no commits.
      unreadable.push(`${wt}: ${readError(err)}`);
    }
  }
  return { total, ahead, unreadable };
}

/**
 * Whether the cycle's work is demonstrably NOT yet on its local branch —
 * the re-entry guard for crash-resume re-post. A second `runHandoff`
 * (the dedupe census: a crash after the comment posted but before the
 * enclosing writeState left the file at "running") must not re-consolidate
 * work that is already on the branch: the cherry-pick orchestrator's
 * tree-hash dedupe makes a redundant run cheap but not free, and a
 * redundant run after an operator manually resolved a conflict would
 * re-introduce it. Returns true when the branch exists locally AND at
 * least one worktree is still ahead of the base; false when the branch is
 * absent (first entry — consolidate) or there is nothing ahead (nothing to
 * move, keep the snapshot the caller built).
 */
export async function workNotYetOnBranch(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string | undefined,
  baseSha: string | undefined,
  worktrees: Record<string, string>,
): Promise<boolean> {
  if (!branchName || !baseSha) return true;
  let branchExists = false;
  try {
    await execFn(`git rev-parse --verify ${JSON.stringify(branchName)}`, { cwd: repoRoot });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  if (!branchExists) return true;
  const { total } = await countAheadOfBase(execFn, repoRoot, baseSha, worktrees);
  return total > 0;
}
