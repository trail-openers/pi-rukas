/**
 * work-driver-retry-tree.ts — #1391: the one thing a step RETRY must do
 * before it re-dispatches into a driver worktree.
 *
 * When a step's child dies mid-stream (a severed provider connection, a
 * watchdog kill) the router re-runs the step by dispatching a brand-new child
 * into the SAME worktree. `develop` treats what the dead child left as an
 * asset — `interruptedDevelopNote` tells the retried developer to continue
 * from it. Every other step treats it as an obstacle, and `lens-fix` is the
 * case that turned a recoverable fault into a parked cycle (tehas cycle
 * 109-261015-212759, err.txt:100-103): the round-2 lens-fix developer was
 * severed after 22 minutes, the retry's own #981 precondition check refused
 * to dispatch a fixer onto the tree the dead attempt left behind, the third
 * round ran for one second, and nothing was fixed.
 *
 * So: before the retry re-dispatches into a worktree, hand that worktree to
 * `cleanWorktreeForRetry` — which preserves the dirt (commit + durable ref +
 * off-tree patch) and only then clears it. The seam refuses to clear when the
 * save does not land, so a retry never destroys the only copy of lost work.
 *
 * The result is returned rather than swallowed: the router folds `files` into
 * `lostAttemptLine` so the scrollback says where the work went instead of
 * claiming a step restarted from nothing when it did not. A failure of the
 * clean is reported to the caller too — the router still retries (the halt
 * path would discard the same dirt with no save at all, which is strictly
 * worse), and the reason rides out in the retry line.
 *
 * Lens-fix is the step this exists for, and the clean is scoped to it plus
 * any step the driver gives its child a worktree for. The pure predicate is
 * exported so the choice of steps is testable without a router.
 */

import { trace } from "./trace.ts";
import type { ExecFn } from "./work-develop-git.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type RetryTreeCleanResult, cleanWorktreeForRetry } from "./work-retry-tree-clean.ts";
import { type WorkState, type WorkStep, appendEvent } from "./workflow-state.ts";

/**
 * Which steps clear their worktree before a retry.
 *
 * `develop` is deliberately absent: its leftover is the retried developer's
 * starting point, and clearing it would throw away the one thing the retry
 * needs. `lens-fix` is present because its gate rejects a dirty tree, so an
 * uncleared tree makes the retry a guaranteed no-op.
 */
export function clearsWorktreeBeforeRetry(step: WorkStep): boolean {
  return step === "lens-fix";
}

export interface RetryTreeOutcome {
  /** The state with the preservation recorded, when a save happened. */
  state: WorkState;
  /** What the clean did — `undefined` when there was no worktree to clean. */
  clean?: RetryTreeCleanResult;
}

/**
 * Preserve-then-clear every workstream worktree of `step` ahead of a retry,
 * recording what was saved in the event log. Never throws; a worktree whose
 * clean fails is left dirty and reported, exactly as the seam decided.
 */
export async function prepareWorktreesForRetry(args: {
  execFn: ExecFn;
  state: WorkState;
  repoRoot: string;
  issue: number;
  issues?: number[];
  step: WorkStep;
  /** The 1-based attempt that was just lost (the retry is attempt + 1). */
  attempt: number;
}): Promise<RetryTreeOutcome> {
  const { execFn, state, repoRoot, step, attempt } = args;
  if (!clearsWorktreeBeforeRetry(step)) return { state };

  const worktrees = Object.entries(state.pipelineState.worktrees ?? {});
  if (worktrees.length === 0) return { state };

  let next = state;
  let last: RetryTreeCleanResult | undefined;
  for (const [workstreamId, worktree] of worktrees) {
    const clean = await cleanWorktreeForRetry(execFn, {
      repoRoot,
      worktree,
      step,
      workstreamId,
      attempt,
      scratchDir: scratchDir(repoRoot, args.issue),
    });
    last = clean;
    if (clean.kind !== "cleaned") {
      // `clean` (nothing to do) and `failed` (the seam refused, tree intact)
      // both record nothing: an unrecorded save must never be claimed later.
      if (clean.kind === "failed") {
        trace(
          `work-driver: retry could not clear ${step}[${workstreamId}] — ${clean.reason} (tree left as the lost attempt left it)`,
        );
      }
      continue;
    }
    next = appendEvent(next, {
      kind: "lens-fix-attempt-preserved",
      at: Date.now(),
      // The event's step is narrowed to `lens-fix` (the only step
      // `clearsWorktreeBeforeRetry` admits today); the guard above is what
      // makes this cast total rather than hopeful.
      step: step as "lens-fix",
      workstreamId,
      attempt,
      commitSha: clean.commit,
      preservedRef: clean.preservedRef,
      worktreePath: worktree,
      files: clean.files,
      ...(clean.patchPath ? { patchPath: clean.patchPath } : {}),
    });
    trace(
      `work-driver: preserved ${step}[${workstreamId}] attempt ${attempt} (${clean.files.length} file(s)) at ${clean.preservedRef} before retry`,
    );
  }
  return { state: next, clean: last };
}
