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
   * trust the fields, don't trust the provenance").
   */
  delivery?: "dispatch" | "fallback";
  /** Path to the handoff markdown body (PR5; back-compat with PR4 events). */
  handoffBodyPath?: string;
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
};

/** #674 — the driver consolidated the parked work onto the feature branch. */
export type HandoffConsolidatedEvent = {
  kind: "handoff-consolidated";
  at: number;
  /** #674 — the feature branch the work was consolidated onto. */
  branchName: string;
  workstreams: string[];
};
