/**
 * /work workflow state — handoff event fragments.
 *
 * Same seam pattern as workflow-state-events-provision.ts and
 * workflow-state-events-leftover.ts: a pure event-type fragment composed into
 * the closed `WorkEvent` union in workflow-state-events.ts by name. Split out
 * there so that growing a handoff event (the #775 `delivery` provenance
 * field, added by its own workstream) lands in this dedicated module rather
 * than inflating workflow-state-events.ts toward the §12 500-line hard cap.
 *
 * Behaviour-neutral: the field names, discriminants and optionality below are
 * byte-identical to the inline union members they replace, so every reader
 * (work-status, work-driver-handoff-message, the recovery renderers, the
 * schema validator's kind check) and every inline constructor in the smoke
 * tests is unchanged.
 */

/**
 * Step 7g — the handoff artifact was emitted. `commentUrl` / `labelApplied`
 * carry what the driver actually delivered (ops dispatch or the in-process
 * forge fallback); the `consolidated*` fields record the #674 pre-handoff
 * worktree consolidation outcome so the renderers can print either the
 * branch-contains-the-work path or the accurate per-worktree fallback.
 */
export type HandoffEmittedEvent = {
  kind: "handoff-emitted";
  at: number;
  /** GitHub URL of the handoff PR/issue comment. */
  commentUrl?: string;
  labelApplied: boolean;
  /**
   * #775 — how the recorded comment/label state was established. Absent on
   * events written before #775 (readers must treat absent as "unknown —
   * trust the fields, don't trust the provenance"). #1327 — `host`: the
   * handoff channel was the host's (`PI_ENSEMBLE_HANDOFF_CHANNEL=host`), so
   * nothing was posted and no label applied by design, not by failure.
   */
  delivery?: "dispatch" | "fallback" | "host";
  /**
   * Set when a freshly re-resolved intent park matched the one a previous
   * cycle already reported (same park reason, issue text and commit): no new
   * comment was posted, and `commentUrl` is the earlier park's. `at` is when
   * that earlier park was reported. See work-driver-park-memory.ts.
   */
  repeatOf?: { at: number; commentUrl: string };
  /** Path to the handoff markdown body (PR5; back-compat with PR4 events). */
  handoffBodyPath?: string;
  /**
   * #1327 — the handoff body itself (marker line first), so the headless
   * result never depends on the file at `handoffBodyPath`, which a failed
   * write leaves missing and a later cycle overwrites. Absent on older events.
   */
  body?: string;
  /**
   * #798 — the explicit target object type of the handoff artefacts (where
   * the comment was posted). A reader must not have to infer this from the
   * comment URL or a sibling `prNumber` field.
   */
  targetType?: "issue" | "pr";
  /** #798 — the number of the target object. */
  targetNumber?: number;
  /**
   * #798 — per-target label verification. When the cycle labels both the
   * issue and the PR (option a, #798), this records whether the ISSUE label
   * was verified on the issue. Absent when only the issue was targeted.
   */
  issueLabelApplied?: boolean;
  /** #798 — per-target label verification: the PR label. Absent when no PR exists. */
  prLabelApplied?: boolean;
  /** #674 — true when the driver consolidated the work onto the branch before rendering. */
  consolidated?: boolean;
  /** #674 — the feature branch the work was consolidated onto (success only). */
  consolidatedBranch?: string;
  /** #674 — workstream ids whose committed work landed on the branch. */
  consolidatedWorkstreams?: string[];
  /** #674 — why consolidation degraded to the per-worktree fallback. */
  consolidationReason?: string;
  /**
   * #1421 fix round — the producer's own reason when consolidation was
   * DECLINED (dirty root, cherry-pick conflict, git error, lock failure),
   * carried on the `handoff-emitted` event, which `/work-status` reads for its
   * `consolid:` line. This is the single carrier: the driver's reason is NOT
   * also written onto the `handoff-consolidated` event, because a field no
   * writer sets and no reader reads is a second place for the same fact to go
   * stale.
   */
  degradedReason?: string;
};

/** #674 — the driver consolidated the parked work onto the feature branch. */
export type HandoffConsolidatedEvent = {
  kind: "handoff-consolidated";
  at: number;
  /** #674 — the feature branch the work was consolidated onto. */
  branchName: string;
  workstreams: string[];
  /**
   * #968 — the verified-restore claim: whether repoRoot was restored to
   * the checkout it was on before consolidation, or why the restore failed
   * (the `restoreClaim` "repoRoot was NOT restored: …" shape). Absent on
   * events written before #968 — readers must treat absent as "restore not
   * recorded" and never as "restored".
   */
  restoreClaim?: string;
};

/**
 * PR6 — runLens skipped child dispatch (empty diff); paired with a
 * synthesised `lens-approved` so the driver advances. Avoids #533
 * hallucinated findings on empty context.
 */
export type LensSkippedEmptyDiffEvent = {
  kind: "lens-skipped-empty-diff";
  at: number;
  round: number;
};
