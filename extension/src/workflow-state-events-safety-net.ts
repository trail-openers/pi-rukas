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
};
