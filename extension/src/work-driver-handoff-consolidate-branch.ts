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
 * mechanism (PM decision 0).
 *
 * #844 round-2 — this is a THIN wrapper over the branch step's
 * `reconcileExistingLocalBranch` (work-driver-branch-mechanized.ts), the
 * PM decision's "one predicate". The only divergence is fetch-down handling:
 * the branch step THROWS on an unreadable base (a branch step has to halt on
 * it), while the handoff must complete, so a fetch that is down degrades to
 * a trace + no-op here instead. Everything else — the ancestry probe, the
 * ahead refusal (BranchAheadError), the `git update-ref` move that works on
 * a branch checked out at repoRoot — is the single shared predicate.
 */

import { trace } from "./trace.ts";
import { detectMainline, reconcileExistingLocalBranch } from "./work-driver-branch-mechanized.ts";
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
  // #844 round-2 — fetch down degrades to a trace + no-op (return undefined)
  // rather than a halt: the handoff must complete, and without a fresh origin
  // ref there is nothing to compare against — the local tip is the best
  // information available. Without this guard the shared predicate's
  // "could not resolve <mainline>" throw would become a handoff failure.
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
  // The single shared predicate (ancestry probe + ahead refusal +
  // `git update-ref` move). The ahead refusal cannot fire in the normal
  // flow: follow-up mode only reaches here for a branch that is NOT checked
  // out at repoRoot, and a local branch AHEAD of the freshly-fetched tip was
  // just reset (or is this cycle's own work, created at the tip) — so a
  // BranchAheadError here would mean a concurrent cycle raced the fetch.
  return reconcileExistingLocalBranch(execFn, repoRoot, branchName, fetchedTip);
}
