/**
 * work-driver-lens-fix-records — the small pure helpers the lens-fix step
 * writes its records with, split from `work-driver-lens-fix.ts` for the
 * AGENTS.md §12 500-line gate (which counts whole files, so the split is the
 * fix rather than shortening the reasoning that lives in the step itself).
 *
 * All three are the *record* side of #1852: what the step writes down before
 * the fixer runs, and what it writes down when it could not write that down.
 * They are separated from the step because each one is a contract with a
 * reader elsewhere — the adversarial fence gate reads the snapshot, the gate's
 * "no record" branch reads the event — and a contract is easier to check
 * against its reader when it is not 400 lines away from the dispatch.
 */
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { LENS_FIX_NO_WORKSTREAM } from "./work-driver-lens-fix-fence-gate.ts";
import type { LensFixPlanRefusal } from "./work-driver-lens-fix-fence.ts";
import type { LensFixPassPlan } from "./work-driver-lens-fix-fence.ts";
import type { LensFixFenceSnapshot } from "./workflow-state-schema.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * The operator-visible text of a refusal. The typed discriminant decides what
 * gets RECORDED; this only renders it, so a reworded reason can never change a
 * branch (`lensFixPlanRefusalRecords` answers that question).
 */
export function refusalReason(refusal: LensFixPlanRefusal | typeof LENS_FIX_NO_WORKSTREAM): string {
  if (typeof refusal === "string") return refusal;
  switch (refusal.kind) {
    case "no-base":
      return "the state records no base SHA, so no fence can be measured";
    case "no-workstream":
      return LENS_FIX_NO_WORKSTREAM;
    case "unrecorded-tree":
      // The reason the operator reads has to say what is missing and what the
      // consequence is: the fixer wrote in a tree no `pipelineState.worktrees`
      // entry claims, so neither the revert nor the fence has anything to work
      // with, and the round parks rather than landing unchecked.
      return "the lens-fix tree is not a recorded workstream, so no fence bounds it and no recorded tree can hold a revert";
    default:
      return refusal.reason;
  }
}

/**
 * Record that THIS round's fence could not be built, so the adversarial gate
 * fails closed instead of skipping (#1852). One writer for every arm that
 * reaches a dispatch without a fence: the gate's "no record" branch must be
 * reachable only by a state that genuinely never had a fence to require.
 */
export function recordFenceUnavailable(
  state: WorkState,
  worktree: string,
  reason: string,
): WorkState {
  const recorded = appendEvent(state, {
    kind: "lens-fix-fence-unavailable",
    at: Date.now(),
    round: state.pipelineState.reviewRound,
    worktree,
    reason,
  });
  // Traced as well as recorded: the event is what the gate reads after a
  // resume, the trace is what an operator reading a live cycle sees, and the
  // two must agree on which round went fenceless.
  trace(
    `lens-fix: round ${state.pipelineState.reviewRound} has no fence — ${reason} (recorded; the adversarial gate refuses to land it unchecked)`,
  );
  return recorded;
}

/**
 * The tree the lens gate works in. #492 — exported so the adversarial gate's
 * lens-fix integration path names the SAME tree. Falls back to repoRoot.
 */
export function lensWorktree(ctx: CycleContext, state: WorkState): string {
  const wt = state.pipelineState.worktrees ?? {};
  return wt.default ?? wt[Object.keys(wt)[0] ?? ""] ?? ctx.repoRoot;
}

/**
 * The record the adversarial step's fence gate reads back: the plan-time fence
 * this round's prompt printed, keyed on the round so a gate that runs in a later
 * round cannot read this one's fence (#1852).
 */
export function fenceSnapshot(
  state: WorkState,
  plan: LensFixPassPlan,
  tree: string,
): LensFixFenceSnapshot {
  return {
    round: state.pipelineState.reviewRound,
    workstreamId: plan.id,
    roundTip: plan.headBefore,
    fence: { ...plan.fence, helperDirs: [...plan.fence.helperDirs] },
    declared: plan.declared,
    named: plan.named,
    candidates: [...plan.candidates],
    findings: plan.findings,
    // The tree the gate must read, recorded rather than re-derived: the gate
    // resolves the lens tree by a separate read, and a gate that checked one
    // tree while the fence was built from another is two fences (the reason
    // `revertStraysOnce` compares its plan's tree against the recorded one).
    worktree: tree,
  };
}
