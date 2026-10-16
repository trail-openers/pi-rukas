/**
 * workflow-state-schema-pr-draft — the PR draft fact and its disclosure record
 * (#1292, extended by #1398).
 *
 * Split from workflow-state-schema.ts for the 500-line cap (AGENTS.md §12).
 * One object answers "may anyone merge this PR yet?" for the cycle's own PR, and
 * one row of it answers the harder sub-question: "were THIS patch's residual
 * findings actually disclosed where the merge guard will look?"
 *
 * The disclosure row is keyed on `patchId` — the
 * `merge-base(remote/head, remote/mainline)..remote/head` identity
 * `mergeIdentity` (merge-guard-reads.ts, #1305) computes, and the same string
 * merge-guard-round-cap.ts compares a PR comment's marker against. Keying on the
 * patch is what makes the record honest: a disclosed finding is not a fix, so a
 * fix push produces a new patch the old disclosure does not describe, and must
 * not inherit a licence to go ready.
 */

/**
 * #1292 — the PR's draft state, recorded only once the PR number is known:
 * `draft` until the review is done, `ready` once marked (or found not to be a
 * draft at all), `ready-failed` (with the last error) when `pr ready` failed.
 * `attempts` counts `pr ready` calls made this cycle (bounded); `holdReason`
 * says why the driver deliberately left it a draft. Absent = no draft fact
 * recorded (the PR was not opened as a draft).
 */
export type PrDraftState = {
  status: "draft" | "ready" | "ready-failed";
  error?: string;
  attempts?: number;
  holdReason?: string;
  /**
   * #1398 — the residual findings of THIS patch were disclosed ON the PR and
   * the merge guard can find them.
   *
   * The authoritative record is the `lens-residuals-posted` EVENT log; this is
   * its mirror on `pipelineState` for the handoff lines and the resume check. A
   * concluded review whose findings were never disclosed holds the PR as a draft
   * rather than marking it ready.
   */
  findingsPosted?: PrDraftFindingsFact[];
};

/** One disclosure of one patch's residual findings, mirrored on `prDraft`. */
export type PrDraftFindingsFact = {
  /** The reviewed patch the posted findings describe. */
  patchId: string;
  /** When the disclosure reached the PR. */
  at: number;
  /** The lens-review round whose findings were posted. */
  round: number;
  /** The PR the disclosure was made on, when the cycle had one. */
  prNumber?: number;
};
