/**
 * work-driver-merged-workstreams — #1533: how many workstreams a cycle's merge
 * covers, the one number that decides whether the head's reviewed identity can
 * be looked up.
 *
 * The driver records adversarial ledger rows PER WORKSTREAM for a grouped
 * cycle, not under the integration branch, so a single-workstream cycle is the
 * only shape where "the latest passing adversarial row for the cycle branch"
 * names a real row. A leaf so both the merged step and its tests ask one
 * function rather than re-deriving it from `Object.keys(worktrees)` — which is
 * not the same set (a worktree can exist for a workstream that never ran).
 */

import type { WorkState } from "./workflow-state.ts";

/**
 * How many workstreams this cycle's merge covers.
 *
 * `workstreams` is the plan's record and the only authoritative list; the
 * degenerate N=1 cycle leaves it unset (the "default" workstream), which is
 * exactly one.
 */
export function workstreamCount(state: WorkState): number {
  const ws = state.pipelineState.workstreams;
  if (!ws) return 1;
  const n = Object.keys(ws).length;
  return n > 0 ? n : 1;
}
