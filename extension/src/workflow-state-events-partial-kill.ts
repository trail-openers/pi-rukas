/**
 * /work workflow state — the `partialAfterKill` disclosure field on the
 * `dispatch-completed` event (#1779).
 *
 * A `lens-fix` child killed AT the bound the review budget arms is converted
 * into a completed dispatch when it had already committed, so the adversarial
 * gate reviews those commits and `integrateLensFix` lands them (see
 * `work-driver-lens-fix-bound-land.ts`). The conversion must be distinguishable
 * from a dispatch that finished normally, and not only in prose: `summary` is
 * text the operator reads, this field is what a reader of the event log checks.
 *
 * Absent = the dispatch finished normally. Split out of
 * workflow-state-events.ts for the 500-line gate (AGENTS.md §12); the event
 * union imports it from here.
 */
export type PartialAfterKill = {
  /** The kill cause the conversion accepted: `timeout` or `child-bound`. */
  killCause: string;
  /** The commits the fixer made on top of the round's starting tip, oldest first. */
  commitShas: string[];
  /** When the kill happened — the converted event's `at` carried verbatim. */
  at: number;
};
