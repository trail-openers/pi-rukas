/**
 * /work workflow state — explore retry event (#1094). A sibling fragment of
 * `workflow-state-events.ts` (module-size hygiene, AGENTS.md §12).
 *
 * Emitted when a COMPLETED explore reply carried no readable `## Spec`, so the
 * driver re-dispatched explore once. Recorded in the log (not pipelineState)
 * so the handoff and `/work-status` can show that the retry happened, and so
 * a second miss is attributable to a retried dispatch rather than a first one.
 */
export type ExploreRetriedEvent = {
  kind: "explore-retried";
  step: "explore";
  at: number;
  /** Why the re-dispatch fired. Only `no-spec` exists today. */
  reason: "no-spec";
  /** Whether the unreadable reply still carried an `INTENT-VERDICT:` token. */
  verdictParsed: boolean;
  /** The job id of the attempt that produced the unreadable reply. */
  firstJobId: string;
};
