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

/**
 * Issue #1240 — the consolidated verify's duplicate-run skip.
 *
 * The develop step verifies twice per pass: once per changed worktree, then
 * once against a probe tree the consolidated run builds at repoRoot by
 * cherry-picking each workstream's own commits onto the base. With ONE
 * workstream whose per-worktree verify just passed, the probe holds the same
 * content the run above already judged, so the second execution proves nothing
 * and costs the full gate a second time (~21 min per pass on the orchard
 * factory). The gate now compares git's own tree object ids and, when it can
 * prove the probe tree IS the tree that passed, records this event instead of
 * running the command.
 *
 * **Why an event and not only a note.** The gate's `notes[]` reach the state
 * file only on a failure path, so a note explaining a fast `develop` would be
 * the one kind of note that never survives to be read — which is precisely the
 * condition the event exists to explain. A fast step must be explainable from
 * the state file rather than inferred from the absence of a 20-minute gap.
 *
 * Deliberately NOT the `verify-flake-recovered` shape: nothing failed and
 * nothing was re-run here. And a skip is not a pass — the event names the
 * identity that justified it, so a reader can confirm the claim rather than
 * take it.
 */
export type ConsolidatedVerifySkippedEvent = {
  kind: "consolidated-verify-skipped";
  at: number;
  /** The step whose consolidated verify was skipped. */
  step: "develop" | "commit-pr";
  /** The tree object id both runs agree on (git's own hash). */
  treeHash: string;
  /** The worktree whose per-worktree verify judged that tree. */
  worktree: string;
  /** How many workstreams the cycle has — the skip requires exactly one. */
  workstreamCount: number;
};

/**
 * Build the #1240 skip event. A factory (rather than a literal at each call
 * site) so the two seams cannot drift on `step`, and so `at` is stamped at
 * the moment of the decision rather than whenever the caller appends.
 */
export function makeConsolidatedVerifySkippedEvent(
  step: "develop" | "commit-pr",
  skipped: { treeHash: string; worktree: string },
  workstreamCount: number,
): ConsolidatedVerifySkippedEvent {
  return {
    kind: "consolidated-verify-skipped",
    at: Date.now(),
    step,
    treeHash: skipped.treeHash,
    worktree: skipped.worktree,
    workstreamCount,
  };
}
