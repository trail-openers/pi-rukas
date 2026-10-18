/**
 * /work workflow state — the `workstream-calls-refused` event (#1652), split out
 * of `workflow-state-events.ts` for the AGENTS.md §12 size limit. The composed
 * union references it by name.
 */

/**
 * #1652 — the plan dispatch's refused `report_workstream` calls: a schema-
 * invalid call, or a duplicate id. Appended BEFORE the dispatch's completion
 * event, so `nextStep()` still routes on the completion; the handoff renders
 * the refusals when the cycle parks. Written only when something was refused.
 */
export type WorkstreamCallsRefusedEvent = {
  kind: "workstream-calls-refused";
  step: "plan";
  /** Which dispatch refused: the primary plan or the one-shot corrective. */
  label: string;
  at: number;
  /** Calls Pi accepted in the same dispatch. */
  accepted: number;
  refused: Array<{ id?: string; reason: string }>;
  /** Refusals beyond the recorded cap (MAX_REFUSALS_RECORDED), counted not stored. */
  omitted?: number;
};
