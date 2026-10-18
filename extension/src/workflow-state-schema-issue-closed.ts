/**
 * #1472 — the closed-issue handoff fields, split from workflow-state-schema.ts
 * (AGENTS.md §12 file-size limit; the same seam `workflow-state-schema-commitpr-root.ts`
 * uses). Re-exported from workflow-state-schema.ts so importers keep their paths.
 */
export interface IssueClosedState {
  /**
   * This handoff DELIBERATELY declines `needs-human-attention`: a person just
   * CLOSED the issue, so nobody needs telling to look at it.
   *
   * Read by all four label writers — `postHandoffToForge`,
   * `postHandoffWithRetry`, `applyIssueLabelDualTarget`, and the prose contract
   * in `inlineHandoffOpsPrompt`. The last is a *prompt* to an @ops child, not a
   * call, so no runtime guard can suppress it: the flag has to travel in state
   * that every one of them reads.
   *
   * It means SKIPPED, not failed. `verifyHandoffLabel` honestly reports an
   * unverified label as `labelApplied: false`, which fires the "HANDOFF
   * DISPATCH INCOMPLETE" banner — so recording a deliberate decline as
   * unapplied would flag a correct handoff as broken.
   */
  handoffLabelSkipped?: boolean;
}
