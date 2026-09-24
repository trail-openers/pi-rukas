/**
 * work-driver-handoff-consolidate-branch — #844 PM decision 1: the
 * stale-local-branch reconciliation for handoff consolidation's follow-up
 * mode.
 *
 * `consolidateWorktreesToBranch`'s follow-up mode runs a plain
 * `git checkout <branch>` and then cherry-picks onto whatever SHA that
 * existing local branch holds. If a prior cycle left the branch at an older
 * main commit while origin/<mainline> advanced, the consolidated diff
 * silently reverts the work that merged in the meantime — the #830
 * mechanism (PM decision 0). This helper applies the SAME single predicate
 * the branch step uses (work-driver-branch-mechanized.ts,
 * `reconcileExistingLocalBranch`): the local branch does NOT contain the
 * freshly-fetched `origin/<mainline>` (behind, or diverged with everything
 * already merged — rebase-able) → force-move it to the fetched tip; it IS
 * ahead → never touch it.
 *
 * Deliberate deviations from the branch step's reset:
 *
 *   - `git update-ref` instead of `git branch -f` — the branch may be
 *     checked out at repoRoot (the handoff's own prior consolidation does
 *     exactly that); `branch -f` refuses a checked-out ref.
 *   - `undefined` instead of a `branch-reset` event — handoff is a
 *     terminal, best-effort path with no state file to append to; the
 *     trace carries the old tip SHA (the recovery handle) in the
 *     session log.
 *   - Fetch-down degrades to a trace (return undefined) rather than a
 *     halt: the handoff must complete, and without a fresh origin ref
 *     there is nothing to compare against — the local tip is the best
 *     information available.
 */

import { trace } from "./trace.ts";
import { detectMainline } from "./work-driver-branch-mechanized.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Reconcile an existing local branch against the freshly-fetched
 * `origin/<mainline>` before handoff consolidation checks it out and
 * cherry-picks onto it. Returns the pre-reset tip SHA when the branch was
 * force-moved to the fetched tip, `undefined` when nothing was touched
 * (no local branch, already at the tip, ahead of the tip, or fetch-down).
 * The reset itself is the only non-read-only operation here.
 */
export async function reconcileHandoffConsolidateBranch(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): Promise<string | undefined> {
  let fetchedTip = "";
  try {
    const mainline = await detectMainline(execFn, repoRoot);
    try {
      await execFn(`git fetch origin ${JSON.stringify(mainline)}`, {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      trace(
        `work-driver: handoff-consolidate fetch of origin/${mainline} failed — skipping stale-branch reconciliation: ${(err as Error).message?.slice(0, 160)}`,
      );
    }
    try {
      const { stdout } = await execFn(
        `git rev-parse --verify --quiet ${JSON.stringify(`origin/${mainline}`)}`,
        { cwd: repoRoot, maxBuffer: 64 * 1024 },
      );
      fetchedTip = stdout.trim();
    } catch {
      fetchedTip = "";
    }
  } catch (err) {
    trace(
      `work-driver: handoff-consolidate mainline detection failed — skipping stale-branch reconciliation: ${(err as Error).message?.slice(0, 160)}`,
    );
  }
  if (!fetchedTip) return undefined;
  let localTip = "";
  try {
    const { stdout } = await execFn(
      `git rev-parse --verify --quiet ${JSON.stringify(`refs/heads/${branchName}`)}`,
      { cwd: repoRoot, maxBuffer: 64 * 1024 },
    );
    localTip = stdout.trim();
  } catch {
    localTip = "";
  }
  if (!localTip || localTip === fetchedTip) return undefined;
  // `git merge-base --is-ancestor fetchedTip <branch>`: exit 0 means the
  // branch contains the fetched tip (it is ahead or equal) → the predicate
  // refuses to reset; anything else (non-zero, missing commit) is
  // "does not contain": behind or diverged → safe to force-move.
  let branchContainsFetchedTip = false;
  try {
    await execFn(
      `git merge-base --is-ancestor ${JSON.stringify(fetchedTip)} ${JSON.stringify(`refs/heads/${branchName}`)}`,
      { cwd: repoRoot, maxBuffer: 64 * 1024 },
    );
    branchContainsFetchedTip = true;
  } catch {
    branchContainsFetchedTip = false;
  }
  if (branchContainsFetchedTip) return undefined;
  // `git update-ref` instead of `git branch -f`: the branch may be checked
  // out at repoRoot (a handoff's own prior consolidation leaves it there),
  // and `branch -f` refuses to move the currently-checked-out ref.
  await execFn(
    `git update-ref ${JSON.stringify(`refs/heads/${branchName}`)} ${JSON.stringify(fetchedTip)}`,
    { cwd: repoRoot, maxBuffer: 64 * 1024 },
  );
  trace(
    `work-driver: handoff-consolidate — stale local branch ${branchName} reset ${localTip.slice(0, 8)} → ${fetchedTip.slice(0, 8)} (fetched origin/<mainline>); old tip recoverable via that SHA`,
  );
  return localTip;
}
