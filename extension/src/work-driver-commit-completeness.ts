/**
 * work-driver-commit-completeness — #728 commit-pr consolidation-completeness
 * cap gate. Extracted from work-driver-commit.ts (500-line gate) to keep
 * that file under the hard limit.
 *
 * The #728 file-level completeness diagnostic (`droppedPaths` from the
 * cherry-pick seam) is persisted by `mechanizedCommitPr` on
 * `pipelineState.consolidationCompleteness`; this module turns a non-empty
 * `droppedPaths` list into the `consolidation-incomplete` cap-hit event —
 * the #723 shape, where a multi-commit worktree staged only its HEAD
 * commit's files and silently dropped the earlier ones. The ops-fallback
 * path leaves no such diagnostic, so the gate is a no-op there (it only
 * runs when the mechanized path produced one). A `checkError` means the
 * git read failed and the comparison could not run — the honest third
 * state, NOT "complete", so it does not raise the cap on its own (it is
 * recorded for the handoff).
 */
import { trace } from "./trace.ts";
import { appendEvent } from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";

export function raiseConsolidationIncompleteCap(next: WorkState): WorkState {
  const mechCompleteness = next.pipelineState.consolidationCompleteness;
  if (mechCompleteness === undefined || mechCompleteness.droppedPaths.length === 0) {
    return next;
  }
  trace(
    `work-driver: commit-pr consolidation incomplete — dropped paths: ${mechCompleteness.droppedPaths.join(", ")}`,
  );
  return appendEvent(next, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "consolidation-incomplete",
    reviewRound: next.pipelineState.reviewRound,
    nextStep: "handoff",
  });
}
