/**
 * /work workflow state — develop fence-recovery event fragment (#849).
 *
 * The develop step's fence recovery is underway when a workstream V committed
 * a sibling-declared fence violation: its commit is discarded (the worktree
 * reset to the declaring owner's post-commit tree) and V is re-dispatched
 * once from that tree. This event is the durable record of that discard —
 * `discardedSha` keeps the discarded commit reachable/auditable: the object
 * stays in the store, and the event names it. It is the record BOTH park
 * shapes (the second-violation park and the violator↔owner-cycle park) cite
 * when naming the first attempt. Carries `at` (no `step` field).
 *
 * Same fragment pattern as the sibling workflow-state-events-*.ts modules:
 * a pure event type composed into the closed `WorkEvent` union in
 * workflow-state-events.ts by name, so the union stays exhaustive and
 * additive (older readers ignore the kind; the schema validator knows it).
 */

/** #849 — one workstream's fence-recovery discard + re-dispatch is underway. */
export type FenceRecoveryStartedEvent = {
  kind: "fence-recovery-started";
  at: number;
  workstreamId: string;
  /** The declaring owner(s) the injected dependsOn edges point to. */
  owners: string[];
  /** The discarded commit — reachable in the object store, named here
   * (absent only if the violator's HEAD could not be read pre-reset). */
  discardedSha?: string;
};
