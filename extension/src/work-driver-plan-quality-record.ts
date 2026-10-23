/**
 * work-driver-plan-quality-record — #1756 (size split): the `planQuality`
 * record the plan step persists, split from work-driver-plan-quality-pass.ts
 * for the AGENTS.md §12 500-line cap.
 *
 * One builder, two writers. The success return persists the record the caller
 * gets back; a park persists it into the state itself, because the halt paths
 * return before the tail's write and used to leave `redispatched: false` behind
 * for a step that dispatched twice. Two shapes for one field is how a persisted
 * verdict starts disagreeing with the cap-hit beside it, so both go through
 * `planQualityRecord`.
 */

import type { PlanQualityInput } from "./work-driver-plan-quality-pass.ts";
import type { PlanQualityReason, PlanUnfenceSummary } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

/** What a corrective left behind on the plan: the dependsOn edges it dropped. */
export type DroppedEdges = { from: string; to: string }[];

/**
 * The single `planQuality` record the caller persists. `redispatched` is the
 * LIVE flag: true whenever this cycle ran a corrective, whether the tail's own
 * (#1756 — a halt must not persist a verdict that denies the corrective
 * happened) or the kill-recovery one.
 */
export function planQualityRecord(
  input: PlanQualityInput,
  redispatched: boolean,
  finalReason: PlanQualityReason | undefined,
  droppedEdges: DroppedEdges | undefined,
  unfence: PlanUnfenceSummary | undefined,
): NonNullable<WorkState["pipelineState"]["planQuality"]> {
  return {
    findingsCount: input.findingsCount,
    redispatched,
    ...(finalReason ? { reason: finalReason } : {}),
    ...(droppedEdges ? { droppedEdges } : {}),
    // #1167 round-3 — the unfence's own record, so the four silences (no
    // fences, unreadable issue body, identifier cap, git failure) are
    // distinguishable in the state file rather than only in `trace()`.
    ...(unfence ? { unfence } : {}),
  };
}

/**
 * #1756 — a halt that follows a corrective dispatch must not persist
 * `planQuality.redispatched: false` and deny the dispatch the cycle paid for.
 * When the state carries no verdict at all — a `dispatch-failed` tail, or a
 * park whose only record was the cap-hit — a record is WRITTEN with
 * `redispatched: true` and NO `reason`: inventing `plan-spec-mismatch` there
 * would blame the planner for a provider error, which is the shape
 * test-plan-workstream-tool.ts pins (a failed corrective ends on its
 * `dispatch-failed`, never on the zero-call verdict). An existing `reason` is
 * always preserved verbatim. No-op when the state already says a corrective ran.
 */
export function withCorrectiveDispatch(
  state: WorkState,
  input: PlanQualityInput,
  droppedEdges: DroppedEdges | undefined,
  unfence: PlanUnfenceSummary | undefined,
): WorkState {
  const prior = state.pipelineState.planQuality;
  if (prior?.redispatched) return state;
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      planQuality: planQualityRecord(input, true, prior?.reason, droppedEdges, unfence),
    },
  };
}

/** The state the success return carries: the disclosures, plus any deferred fence. */
export function withDeferredProtectedDeclared(
  disclosed: WorkState,
  deferredProtected: string[] | undefined,
): WorkState {
  return deferredProtected === undefined
    ? disclosed
    : {
        ...disclosed,
        pipelineState: { ...disclosed.pipelineState, deferredProtected },
      };
}
