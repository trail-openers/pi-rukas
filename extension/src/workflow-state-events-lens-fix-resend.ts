/**
 * workflow-state-events-lens-fix-resend — #654: the lens-fix step's empty-diff
 * re-dispatch marker.
 *
 * Split from `workflow-state-events.ts` for the AGENTS.md §12 500-line gate
 * (the same seam that already moved the handoff, interrupted, verify and
 * residuals members into their own fragments). It has no `step` field — it
 * names the review round and the worktree instead — so the validator's step
 * check skips it.
 */
export type LensFixEmptyResendEvent = {
  /** #654 — empty-diff re-dispatch marker (see runLensFix). */
  kind: "lens-fix-empty-resend";
  at: number;
  jobId: string;
  round: number;
  /** The worktree the driver inspected and found clean. */
  worktree: string;
  /** The git evidence that established the no-diff classification. */
  evidence: string;
};
