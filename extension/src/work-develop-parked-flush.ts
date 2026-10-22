/**
 * work-develop-parked-flush — #1742 (MINOR 2), the ONE flush every mid-step
 * develop park shares.
 *
 * A develop step that parks part-way through must land the same shape: the
 * write-ahead `beginDispatch` marker cleared, every sibling / skip-cascade
 * `branch-completed` the phases collected appended BEFORE the cap (so the cap
 * stays the log tail `nextStep` reads), and the worktree + base maps the phases
 * created folded in — a later resume reads trees that exist. The dirty-leftover
 * park passes `[]` because `parkDeferredLeftover` already flushed them; the
 * budget and #1768 unfinished parks pass the events they collected.
 *
 * Extracted from `work-develop-topological.ts` (AGENTS.md §12 module size) so
 * the step handler and `work-develop-unfinished-pass.ts` share one copy without
 * one importing the other. Two hand-written copies of this block is how one of
 * them ends up dropping the cascade.
 */

import { clearDispatch } from "./work-driver-resume.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

export function flushParkedSiblings(
  state: WorkState,
  jobId: string,
  events: readonly WorkEvent[],
  worktrees: Record<string, string>,
  workstreamBaseShas: Record<string, string>,
): WorkState {
  const cleared = appendEvent(clearDispatch(state, jobId), ...events);
  return {
    ...cleared,
    pipelineState: {
      ...cleared.pipelineState,
      worktrees,
      workstreamBaseShas: {
        ...workstreamBaseShas,
        ...cleared.pipelineState.workstreamBaseShas,
      },
    },
  };
}
