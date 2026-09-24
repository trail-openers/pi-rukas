/**
 * /work workflow state — branch-reset event type.
 *
 * Issue #844 — the branch step's stale-branch reconciliation
 * (work-driver-branch-mechanized.ts) records, when a local branch of the
 * resolved name is force-moved to the freshly-fetched base, BOTH the old
 * tip and the new one: the old SHA is the recovery handle (the operator
 * can `git checkout <oldSha>` to inspect the stale work) and the event is
 * the machine-readable audit trail the handoff renderers read. Same seam
 * pattern as workflow-state-events-leftover.ts: a pure event-type fragment
 * composed into the closed `WorkEvent` union by name.
 */
export type BranchResetEvent = {
  /** #844 — the branch step force-moved a stale local branch to the base. */
  kind: "branch-reset";
  at: number;
  /** The local branch that was force-moved (the cycle's resolved branch name). */
  branch: string;
  /** The branch's pre-reset tip — the recovery handle for the stale work. */
  oldSha: string;
  /** The branch's new tip — the freshly-fetched base the cycle now bases on. */
  newSha: string;
};
