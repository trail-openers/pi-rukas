/**
 * work-driver-cherry-pick-conflict — #813: the shape of a conflicted
 * cherry-pick batch, split out of work-driver-cherry-pick.ts (AGENTS.md §12
 * file-size cap).
 *
 * `cherryPickWorkstreams` used to signal a conflict with the bare string
 * `"conflict"`. That said *that* the batch aborted and nothing about *which*
 * pick failed or what had already applied cleanly — so every caller upstream
 * filled the gap with the same guess: "two workstreams edited the same lines;
 * the decomposition is incoherent", and told the operator to re-split.
 *
 * Since #1005 merges genuinely coupled workstreams at plan time, that guess
 * is usually wrong for the pair that still collides: disjoint declared paths
 * that couple through TYPES (the #792 DeliverableStatus/ConvergeEvidence
 * shape) collide at consolidation with no fence violation anywhere, and
 * re-splitting the same split cannot converge. The fields below are what the
 * batch actually observed, so the reporters describe the observation and the
 * reader decides whether the workstreams are coupled.
 */

export interface CherryPickConflict {
  /**
   * The discriminator. A structural marker (not a bare string) so the type
   * carries the observation alongside it.
   */
  __conflict: true;
  /** The workstream whose pick failed (the batch aborts at the first). */
  conflictedAt: string;
  /** Workstreams whose picks applied cleanly before the aborting pick. */
  appliedBeforeConflict: string[];
}
