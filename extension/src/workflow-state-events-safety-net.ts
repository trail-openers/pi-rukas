/**
 * /work workflow state — safety-net event fragment.
 *
 * The `safety-net-commit` event, split out of `workflow-state-events.ts`
 * (AGENTS.md §12 module-size hygiene). The composed union in
 * `workflow-state-events.ts` references it by name, keeping the union
 * exhaustive.
 */

/**
 * #622 — the driver's mechanical auto-commit safety net fired for a
 * worktree that has uncommitted changes but no commits ahead of baseSha.
 *
 * The developer's prompt (post-#621) explicitly instructs them to
 * `git add` + `git commit`, and the verify gate requires commits ahead
 * of baseSha. But smaller models can still skip the commit step due
 * to constraint drift over long contexts. This safety net — run
 * driver-side AFTER all developer dispatches complete but BEFORE the
 * verify gate — catches the gap mechanically.
 *
 * Emitted only when the safety net actually fired (not when it skipped
 * because the work was already committed or the tree was clean).
 * `commitSha` is the SHA of the driver-created commit, so `/work-status`
 * and handoff artifacts can show what was committed.
 */
export type SafetyNetCommitEvent = {
  kind: "safety-net-commit";
  at: number;
  /** Workstream id (e.g. "default" or "task-a"). */
  workstreamId: string;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** SHA of the driver-created commit. */
  commitSha: string;
  /** Number of files the safety net committed (porcelain entry count). */
  filesCommitted: number;
  /**
   * #1768 — this commit is a RECOVERY commit the DRIVER created, not the
   * child's work. Always set on new records; absent only on state files
   * written before #1768, which were the same driver-created commit under a
   * message a reader could mistake for a developer's seam commit.
   *
   * The distinction is the issue: the console used to print
   * `safety net committed default (d81ce007) — 6 file(s)` beside
   * `agent done: developer` while the child's own last line said work
   * remained, and nothing on the surface said the commit was the driver's.
   * A driver commit never makes an unfinished pass done —
   * `work-develop-unfinished.ts` discounts commits carrying the net's own
   * subject when it asks whether the pass committed its work.
   */
  recovery?: true;
  /**
   * #1768 / #1773 — every commit SHA this event created (the checkpoint's
   * own-commit scan reads it; the unfinished rule reads it too).
   *
   * The subject prefix alone is not sufficient attribution: the net commits its
   * paths explicitly, so a later `git add <file>` by the corrective child that
   * re-stages one of those paths produces a commit carrying the net's CONTENT
   * under the child's own subject. Discounting by SHA is exact and survives
   * that; the subject remains the fallback for state files written before this
   * field existed.
   */
  commitShas?: string[];
};
