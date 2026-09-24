/**
 * /work workflow state — verify-flake-recovered event fragment.
 *
 * #782 — the consolidated-tree verify gate (develop + commit-pr seam) runs
 * the project's verify command exactly once. A single transient flake (the
 * #777/#296 watchdog-timing class under parallel-fanout load) used to be
 * classified and parked, costing a full cycle + handoff for one flaky
 * assertion. The gate now re-runs the SAME command ONCE in the SAME still-
 * checked-out scratch tree before classifying; when the re-run passes, this
 * event is emitted (with the original failing tail preserved) and the driver
 * proceeds — no cap-hit, no park.
 *
 * Same fragment pattern as the sibling workflow-state-events-*.ts modules:
 * a pure event type composed into the closed `WorkEvent` union in
 * workflow-state-events.ts by name, so the union stays exhaustive and
 * additive (older readers ignore the kind; the schema validator knows it).
 */

export type VerifyFlakeRecoveredEvent = {
  /**
   * Emitted by the consolidated-tree verify gate when the first run failed
   * but the single bounded re-run (same command, same scratch tree, BEFORE
   * the restore) passed. The driver proceeds — this event is the audit trail
   * that the failure was a flake, not a consolidation-created defect.
   */
  kind: "verify-flake-recovered";
  at: number;
  /** The step whose consolidated verify gate recovered: "develop" or "commit-pr". */
  step: "develop" | "commit-pr";
  /**
   * The original first-run failing tail (best-effort, preserved verbatim so
   * the event log carries what the flake looked like). The re-run output is
   * success by definition and is not recorded.
   */
  evidenceTail?: string;
};

/**
 * Issue #279 — verify-full tier status event (driver-side, ci step).
 * Lives in this verify fragment (same domain: verify-tier outcomes) to
 * keep the main union file under the §12 500-line limit.
 */
export type VerifyFullStatusEvent = {
  kind: "verify-full-status";
  at: number;
  status: "success" | "failure" | "skipped";
  /** Time spent executing the full suite (ms). Undefined when skipped. */
  ms?: number;
  /** Tail of the command output for the handoff/comment body. */
  evidenceTail?: string;
  /**
   * #782 — this success is the result of the single bounded re-run: the
   * first run failed, the re-run (same command, same worktree) passed
   * BEFORE the ciRetryCount bump. Additive: absent on every non-recovered
   * outcome and on pre-#782 state files.
   */
  recovered?: boolean;
};
