/**
 * /work workflow state — the `converge-redispatch` event fragment (#1768).
 *
 * Moved VERBATIM from `workflow-state-events.ts` (AGENTS.md §12 module-size
 * hygiene) to keep that file under the 500-line cap after #1768 added the
 * `unfinished` fragment to `branch-completed`. The composed union references it
 * by name, so the union stays exhaustive and no field's prose moved.
 */

/**
 * #741 — the end-of-develop converge gate's one-shot corrective
 * developer dispatch completed (the first absent set was reported to a
 * re-dispatch). The follow-up gate re-ran; whether it passed is visible
 * on the next event (cap-hit develop-incomplete-deliverables or step
 * completion).
 *
 * #1768 — ALSO written by the unfinished-develop corrective round: a child
 * that reported ok, committed nothing of its own and left its work uncommitted
 * earns exactly one such round, resumed from the disk state. The record is the
 * durable proof the round ran, so a resumed cycle does not pay for a second.
 */
export type ConvergeRedispatchEvent = {
  kind: "converge-redispatch";
  step: "develop";
  at: number;
};
