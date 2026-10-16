/**
 * /work workflow state — lens-fix-attempt-preserved event fragment (#1391).
 *
 * A lens-fix child that dies mid-stream (a severed provider connection, a
 * watchdog kill) leaves its half-written edits in the lens-fix worktree. The
 * step retry re-dispatches a brand-new child into that SAME tree, and the
 * #981 reposition gate — correctly — refuses to dispatch a fixer onto a dirty
 * base. Measured on tehas cycle 109-261015-212759: the retry's own
 * precondition check was defeated by the failure it was retrying after
 * (`lens-fix-reposition` cap, `dirty: worktree has uncommitted changes: …`),
 * the third round lasted one second, and the only copy of the lost work was a
 * scratch diff nobody read.
 *
 * So the driver now preserves the lost attempt's dirt BEFORE it clears the
 * tree for the retry: one driver-attributed commit, a durable preserved ref,
 * and a patch copy in the cycle's scratch dir. This event is the record of
 * that save — without it the clearing looks like a deletion, and an operator
 * chasing a parked cycle has no way to find what was thrown away.
 *
 * One event per retry save, and only when the save actually ran: a clean tree
 * that needed nothing records nothing, so the retry line cannot claim a
 * phantom save (see `lostAttemptLine`). A save that FAILED is also not
 * recorded here — nothing was preserved in that case, and the cycle parks.
 *
 * Same fragment pattern as the sibling workflow-state-events-*.ts modules: a
 * pure event type composed into the closed `WorkEvent` union in
 * workflow-state-events.ts by name, so the union stays exhaustive and
 * additive (older readers ignore the kind; the schema validator knows it).
 */

/** #1391 — a lost lens-fix attempt's uncommitted work was preserved + cleared. */
export type LensFixAttemptPreservedEvent = {
  kind: "lens-fix-attempt-preserved";
  at: number;
  /** The step whose attempt died: `lens-fix` for the incident, but the seam
   *  is the retry's, so a sibling step's tree can be named honestly. */
  step: "lens-fix";
  /** Workstream id whose worktree was cleared (e.g. "default"). */
  workstreamId: string;
  /** The 1-based attempt that was LOST (the retry is attempt + 1). */
  attempt: number;
  /** The driver-created commit holding the preserved work (HEAD at save time). */
  commitSha: string;
  /** The durable ref naming that commit — the operator's recovery handle. */
  preservedRef: string;
  /** Absolute worktree path the save + clear applied to. */
  worktreePath: string;
  /** The preserved paths, verbatim from porcelain (bounded by the writer). */
  files: string[];
  /** The scratch-dir patch copy, when one was written. */
  patchPath?: string;
};
