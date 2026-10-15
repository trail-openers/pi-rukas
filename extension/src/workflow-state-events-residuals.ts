/**
 * /work workflow state — lens-residuals-post-failed event fragment.
 *
 * The six-pass review's residual-findings disclosure (lens-review-residuals.ts)
 * is the PR comment the merge guard reads. When posting it failed, the reason
 * used to land in `summary.note`, which only the hand-run review tool reads —
 * the driver dropped it, and with it the findings. The driver now posts them
 * to the issue instead (work-driver-pr-gone.ts) and records this event either
 * way, so `/work-status` and the state file say where the findings went.
 */

/** A residual-findings disclosure that did not reach the PR. */
export type LensResidualsPostFailedEvent = {
  kind: "lens-residuals-post-failed";
  at: number;
  /** The lens-review round whose findings these are. */
  round: number;
  /** The PR the disclosure was addressed to, when the cycle had one. */
  prNumber?: number;
  /** Why the PR post failed (the review's disclosure note). */
  reason: string;
  /** Whether the findings were then posted to the issue. */
  issueFallback: "posted" | "failed";
  /** The issue comment's URL when posted, the error when not. */
  detail?: string;
};
