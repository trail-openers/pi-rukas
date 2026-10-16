/**
 * work-driver-step-clean — #1391: the retry-time clean of the worktree a retried
 * step dispatches into, and the one line that accounts for it.
 *
 * Split from `work-driver-step-router.ts` for the AGENTS.md §12 500-line gate;
 * the router calls it from both retry branches (the HALT-class transient retry
 * and the RETRY_ONCE retry) immediately before it emits the retry line. The
 * policy itself lives in `work-retry-tree-clean.ts`; this is the thin adapter
 * that reads the driver context, and it is deliberately non-fatal in every
 * direction: a retry that could not clean still runs, because the step's own
 * gate is what decides whether a base is trustworthy.
 */

import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import {
  cleanAttemptLine,
  cleanWorktreeForRetry,
  retryTargetTree,
} from "./work-retry-tree-clean.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state-schema.ts";

/**
 * What the lost attempt left behind, and what the driver did about it.
 *
 * The retry dispatches a brand-new child into the SAME worktree the dead one
 * was using. When the step owns that tree (`develop`, `lens-fix`) the leftover
 * edits are saved and discarded first — otherwise the retry's own precondition
 * is defeated by the failure it is retrying after, which is how tehas cycle 109
 * met `worktree has uncommitted changes: M DESIGN.md, …` on a round-3 lens-fix
 * and parked after one second.
 *
 * Returns the operator-facing account (undefined when there is nothing to say),
 * which rides on the retry line so the operator sees what was moved out of the
 * way and where the copy lives.
 */
export async function treeCleanLine(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
  attemptThatFailed: number,
): Promise<string | undefined> {
  try {
    const clean = await cleanWorktreeForRetry({
      execFn: ctx.verifyExecFn,
      repoRoot: ctx.repoRoot,
      issue: ctx.issue,
      step,
      attempt: attemptThatFailed,
      state,
    });
    const tree = retryTargetTree(ctx, state, step);
    const line = tree === undefined ? undefined : cleanAttemptLine(step, tree, clean);
    if (line !== undefined) trace(`work-driver: retry tree clean on step="${step}" — ${line}`);
    return line;
  } catch (err) {
    // The seam is documented never to throw; a throw here is a defect, and
    // losing the retry over it is the worse outcome.
    trace(`work-driver: retry tree clean threw on step="${step}": ${(err as Error).message}`);
    return undefined;
  }
}
