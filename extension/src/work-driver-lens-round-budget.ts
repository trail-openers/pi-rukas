/**
 * work-driver-lens-round-budget — the child bound a lens ROUND needs, and the
 * re-exports the loop's two budget modules share.
 *
 * The bound is derived from the lens round's own floor rather than stated
 * twice: what each lens child runs under, so the wrap-up steer lands before
 * the loop budget expires.
 *
 * Split out of `work-driver-lens-fix-budget.ts` (AGENTS.md §12 file-size limit).
 * #1789 — the shared primitives (`MIN_FIX_DISPATCH_MS`, `lensRoundReserveMs`,
 * the remaining-budget arithmetic) live in the LEAF
 * `work-driver-lens-loop-numbers.ts`, which this module and
 * `work-driver-lens-fix-budget.ts` BOTH import. Before that, these two files
 * imported each other — the fixer's bound needed the round's reserve, the
 * round's child bound needed the fixer's floor — a cycle between two modules
 * that share constants. The re-exports below keep every existing importer's
 * path stable while the cycle is gone.
 */

import { reviewRemainingMs } from "./work-driver-lens-fix-budget.ts";
import { lensRoundChildBoundFromRemaining } from "./work-driver-lens-loop-numbers.ts";
import type { WorkState } from "./workflow-state.ts";

export {
  MIN_FIX_DISPATCH_MS,
  lensRoundReserveMs,
  remainingFromClock,
} from "./work-driver-lens-loop-numbers.ts";

/**
 * #1242 / #1564 — each lens child's run bound: its own (30 min), shortened so
 * the wrap-up steer lands a grace before the loop budget expires and the kill
 * at it. A round that crosses the cap ends there, its unfinished lanes
 * not-reviewed, instead of every lens running on past it.
 */
export function lensRoundChildBoundMs(state: WorkState, now: number): number {
  return lensRoundChildBoundFromRemaining(reviewRemainingMs(state, now));
}
