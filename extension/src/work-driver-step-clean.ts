/**
 * work-driver-step-clean — #1391: the router's call into the retry save-then-
 * clean (`work-retry-tree-clean.ts`), and what it does with the result.
 *
 * Both retry branches of `routeStepOutcome` (the HALT-class transient retry and
 * RETRY_ONCE) call `cleanTreeBeforeRetry` after bumping their budget and before
 * the retry line, so a clean cannot exist in one branch only. Split from the
 * router for the AGENTS.md §12 500-line gate.
 *
 *  - work in the tree → a `retry-tree-clean` event names the files, the ref and
 *    the patch (`/work-status` and the handoff render it);
 *  - a failed save → the cycle parks (`step-failed:<step>`, the save failure as
 *    evidence) and the step is NOT re-dispatched: a retry on a tree the driver
 *    could neither save nor clean would park on the same dirt or build on it.
 */

import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { cleanWorktreeForRetry, retryTreeLine } from "./work-retry-tree-clean.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

const NAMED = 20;

export async function cleanTreeBeforeRetry(
  ctx: CycleContext,
  stateIn: WorkState,
  step: WorkStep,
  attemptThatFailed: number,
): Promise<{ state: WorkState; parked: boolean; line?: string }> {
  const clean = await cleanWorktreeForRetry({
    execFn: ctx.verifyExecFn,
    repoRoot: ctx.repoRoot,
    issue: ctx.issue,
    step,
    state: stateIn,
  });
  if (clean.kind === "none") return { state: stateIn, parked: false };
  const line = retryTreeLine(clean);
  trace(`work-driver: retry tree on step="${step}" — ${line}`);
  let state = appendEvent(stateIn, {
    kind: "retry-tree-clean",
    at: Date.now(),
    step,
    attempt: attemptThatFailed,
    outcome: clean.kind,
    worktree: clean.tree,
    files: clean.files.slice(0, NAMED),
    fileCount: clean.files.length,
    ...(clean.kind === "cleaned" ? { ref: clean.ref, patch: clean.patch } : { detail: clean.why }),
  });
  if (clean.kind !== "failed") {
    await persistCycle(ctx, state);
    return { state, parked: false, line };
  }
  state = appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: `step-failed:${step}`,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: `the lost ${step} attempt's work could not be saved, so the tree was not cleaned and the step was not retried: ${clean.why}`,
  });
  state = { ...state, pipelineState: { ...state.pipelineState, currentStep: "handoff" } };
  await persistCycle(ctx, state);
  trace(`work-driver: HALT on step="${step}" — retry tree save failed: ${clean.why} → handoff`);
  return { state, parked: true, line };
}
