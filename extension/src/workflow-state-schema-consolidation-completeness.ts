/**
 * #728 (task-a) — the consolidation-completeness record type, split from
 * workflow-state-schema.ts (AGENTS.md §12 file-size limit — the #728
 * consolidation-incomplete cap + this field pushed the schema past the
 * 500-line gate).
 *
 * The cherry-pick seam (work-driver-cherry-pick.ts `orchestrateCherryPick`)
 * compares what consolidation INTENDED to stage — the union of every
 * committed workstream's cumulative `git diff --name-only baseSha..worktree-
 * HEAD` — against what ACTUALLY landed on the integration branch, and
 * persists the result here on `pipelineState.consolidationCompleteness` so
 * the handoff renderers can name WHAT was dropped (the #723 silent-drop
 * class) without re-running git.
 *
 * `droppedPaths` empty + no `checkError` = the consolidated tree is proven
 * complete. `checkError` is the honest "could not verify" state (a git read
 * failed mid-check) and must never be read as complete.
 */
export interface ConsolidationCompleteness {
  /** The intended stage set — union of each committed workstream's
   *   cumulative baseSha..HEAD diff name-set (normalised). */
  intended: string[];
  /** What actually landed — baseSha..HEAD at repoRoot plus the index. */
  landed: string[];
  /** intended \ landed — the dropped paths. A non-empty value is the
   *   consolidation-incomplete failure; the consumers route it to the
   *   distinct `consolidation-incomplete` cap (task-b wires them). */
  droppedPaths: string[];
  /** Present when the git read failed so the comparison could not run.
   *   Never read as "complete". */
  checkError?: string;
}
