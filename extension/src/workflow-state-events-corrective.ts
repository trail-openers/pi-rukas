/**
 * /work workflow state — the `corrective-round` event (#1667).
 *
 * The develop step gives a cycle ONE corrective round when its verify fails
 * with specific, attributed assertion lines. One event per workstream the
 * round dispatched, appended BEFORE that developer runs (write-ahead): a
 * resumed cycle counts the round from the event log, so a crash mid-round can
 * never buy a second one. Split out of workflow-state-events.ts for the
 * 500-line gate (AGENTS.md §12); the event union imports it from here.
 */
export type CorrectiveRoundEvent = {
  kind: "corrective-round";
  at: number;
  step: "develop";
  /** The workstream this corrective developer was given its own failing lines for. */
  workstreamId: string;
  /** The round's number. A cycle runs at most one round, so this is always 1. */
  attempt: 1;
  /** The verify command whose failure the round was built from. */
  command: string;
  /** The bounded assertion lines this workstream's developer was given. */
  evidenceLines: string[];
  /**
   * #1698(b) — the worktree's HEAD when this record was written, i.e. before
   * any corrective developer started. The fix-pass fence bounds its corrective
   * admission to files `git` reports as committed AFTER this commit, so an
   * evidence-named file the pass itself wrote before the round is still a
   * stray. Absent (a record written before #1698(b), or a HEAD the driver
   * could not read) admits NOTHING: the fence's corrective route refuses it with
   * the `no-baseline` reason — the commit window is the proof, and a record with
   * no baseline proves nothing. See `CorrectiveRefusal` in
   * work-driver-corrective-admission.ts for that route's whole vocabulary.
   */
  headAtRound?: string;
};
