/**
 * work-develop-fence-merge-records — #1862: the record shape for fences the
 * develop-phase fence fold dropped, and the one line that gathers them.
 *
 * `work-develop-fence-merge.ts` merges a scope-fence violator into the
 * workstream it violated and re-dispatches. That fold can drop a fence entry
 * which fenced the merged workstream's OWN declared paths (the rule lives in
 * `workstream-fold-self-fence.ts`, and the fold answers to it because a merge
 * must never leave a workstream fenced out of its own work). The develop gate's
 * #784 self-fence demotion still governs whatever fence survives, so what the
 * fold dropped is RECORDED rather than re-judged here — an operator reading the
 * state file can see a fence that was in the plan and is now gone, and why.
 *
 * Its own module for the same reason as `work-develop-fence-scope.ts`: the merge
 * pass is at the AGENTS.md §12 line limit and this concern is a record type plus
 * one loop, not part of deciding which workstreams merge.
 */

import type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";

/** Fence entries the folds removed because they fenced the merged workstream's
 * own declared paths. Absent when nothing was removed — a cycle that dropped
 * nothing reads identically to one that never ran this code. */
export type FoldSelfFenceDrops = UnfenceRecord[];

/** Accumulates the drops one fold reports, in fold order, into the array
 * `MergePrepOutcome.selfFenceDrops` carries. */
export function collectSelfFenceDrops(sink: FoldSelfFenceDrops, drops: FoldSelfFenceDrops): void {
  for (const d of drops) sink.push(d);
}
