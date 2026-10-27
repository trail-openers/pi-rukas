/**
 * /work workflow state — the fix-pass stray-revert event (#1846).
 *
 * An adversarial fix pass that leaves files outside its fence used to park the
 * whole cycle (cap `fix-pass-park`) with a note telling a human to revert them
 * by hand. The driver can do that itself, losslessly: it preserves the strays
 * under a durable ref and a binary patch, reverts exactly those paths to the
 * pass's recorded pre-pass head, and continues. This event is the disclosure of
 * one such revert — the paths it removed and the two places the removed content
 * still lives.
 *
 * Why both a ref AND a patch, when either alone looks sufficient: a stray can
 * be a COMMITTED file (the fixer commits its work before the post-pass fence
 * reads the tree), so a ref to the pre-revert HEAD is what makes the content
 * reachable through git; and it can be UNTRACKED, which no ref reaches, so the
 * patch plus the copied untracked files is what makes it reachable at all. An
 * operator restoring a reverted helper uses whichever of the two the file was.
 *
 * Deliberately NOT a new cap: a revert is the driver doing the work a human was
 * previously asked to do, and it happens at most once per workstream — the
 * SECOND stray set parks as before, cap included.
 *
 * Same fragment pattern as the sibling workflow-state-events-*.ts modules: a
 * pure event type composed into the closed `WorkEvent` union by name.
 */

/** #1846 — the driver reverted one workstream's out-of-fence fix-pass files. */
export type FixPassStraysRevertedEvent = {
  kind: "fix-pass-strays-reverted";
  at: number;
  workstreamId: string;
  /** The paths the revert removed from the worktree, in the order reverted. */
  paths: string[];
  /**
   * The durable ref the pre-revert HEAD was preserved under
   * (`refs/pi-rukas/fix-pass-strays/<issue>-<workstream>-<n>`). Recovery path
   * for a reverted file that was TRACKED: `git show <preservedRef>:<path>`.
   */
  preservedRef: string;
  /**
   * The binary patch of the reverted paths, written under the cycle's scratch
   * dir. Recovery path for a reverted file that was UNTRACKED (a ref cannot
   * reach an untracked file, so the patch and its copies are the only record).
   */
  patchPath: string;
  /**
   * #1852 — which gate performed this revert. The one-shot counter is keyed on
   * it: the fix pass counts reverts inside its own `adversarial-fix-requested`
   * window, and the lens-fix counter counts events whose `source` is
   * `"lens-fix"`, in the current round, for this workstream (PM decision
   * #1852-5). Absent = the adversarial fix pass, which is every event written
   * before #1852 — so a pre-#1852 state file still reads as a fix-pass revert
   * rather than being counted against a lens round that never reverted anything.
   */
  source?: "fix-pass" | "lens-fix";
  /**
   * #1852 — the lens-fix round (`pipelineState.reviewRound`) this revert
   * belongs to, so "once per lens-fix round" is answerable from the log and
   * survives a resume. Absent on the fix pass's reverts (it has no round) and
   * on every pre-#1852 event.
   */
  round?: number;
};
