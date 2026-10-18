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

/**
 * #1398 — a residual-findings disclosure that DID reach the PR, and the fact
 * `markDraftPrReady` holds the PR as a draft on.
 *
 * The failure event above existed and the success event did not, so "were this
 * round's findings disclosed?" was re-inferred from which cap NAME had
 * appeared in the log (`capHitNamesOf` matching round-cap / lens-review-timeout). Any
 * `ISSUES_FOUND` followed by something other than a round/wall-clock cap that
 * parks — `dispatch-failed`, `verify-failed:*`, a kill cause, `ci-retry` —
 * read as "nothing to hold for" and the PR was marked ready over findings
 * nobody ever posted. A positive fact, recorded by the ordinary disclosure
 * path and the round-cap route alike, replaces the inference.
 *
 * `patchId` is the disclosure's own identity (`merge-base(remote/head,
 * remote/mainline)..remote/head` — the same string the merge guard compares),
 * so a fact recorded for a patch the review then changed can never license
 * marking the new patch ready.
 */
export type LensResidualsPostedEvent = {
  kind: "lens-residuals-posted";
  at: number;
  /** The lens-review round whose findings these are. */
  round: number;
  /** The PR the disclosure was made on, when the cycle had one. */
  prNumber?: number;
  /** The branch the disclosure was made against — a fact is per-branch. */
  branch: string;
  /** The reviewed patch the posted findings describe. */
  patchId: string;
  /**
   * #1398 round 3 — the marker string the posted comment carries, i.e.
   * `lensResidualsMarker(branch, patchId)` as the poster built it. Carried on
   * the row so the invariant "every writer of this fact corresponds to a
   * comment that carries the marker" is checkable against the event itself
   * (test-draft-disclosure-carries-marker-1398.ts) rather than against a
   * caller's prose: the fact must never license a ready that the PR cannot show,
   * and a reader of the state file can now see what the PR was supposed to carry.
   */
  marker: string;
  /**
   * Only `"pr"`. An issue-fallback post is not a disclosure ready purposes
   * count (the merge guard reads PR comments only), and records the failure
   * event instead — the field is here so the event states its own scope
   * rather than leaving the reader to infer it.
   */
  target: "pr";
};
