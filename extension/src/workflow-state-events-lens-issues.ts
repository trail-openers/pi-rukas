/**
 * /work workflow state — the `lens-issues-found` event fragment.
 *
 * Moved VERBATIM from `workflow-state-events.ts` (AGENTS.md §12 module-size
 * hygiene) to give that file headroom for #1768's `unfinished` field on
 * `branch-completed`, which the brief requires be added via a fragment rather
 * than inline. The composed union references this by name, so the union stays
 * exhaustive and no field's documentation moved.
 */
export type LensIssuesFoundEvent = {
  kind: "lens-issues-found";
  at: number;
  jobId: string;
  round: number;
  /** #1742 — the pushed branch head this round read (`lensReviewedHead`), so a later route can tell whether the verdict still describes the current head. */
  headSha?: string;
  findings: string;
  /** "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND" — preserved verbatim from the verdict. */
  verdict: "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND";
};
