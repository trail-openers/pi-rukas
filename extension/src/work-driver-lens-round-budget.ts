/**
 * work-driver-lens-round-budget — the reserve and the child bound a lens ROUND
 * needs, read by both sides of the review loop.
 *
 * Two numbers, both derived from the lens round's own floor rather than stated
 * twice: what a fixer may never spend (so a committed fix cannot starve the
 * re-review it owes) and what each lens child is bound to so the wrap-up steer
 * lands before the loop budget expires.
 *
 * Split out of `work-driver-lens-fix-budget.ts` (AGENTS.md §12 file-size limit).
 */

import { childBoundGraceMs, lensChildBoundMs } from "./spawn-child-bound.ts";
import { LENS_REVIEW_MIN_USEFUL_MS } from "./work-driver-deadline.ts";
import { MIN_FIX_DISPATCH_MS, reviewRemainingMs } from "./work-driver-lens-fix-budget.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * #1742 — the slice of the loop budget a fixer may never spend: the minimum
 * a lens round needs to be worth starting (`MIN_USEFUL_MS["lens-review"]`).
 *
 * A committed fix OWES a re-review: the loop's contract is fix → re-review,
 * and a budget that lets the fixer spend everything but the re-review breaks
 * it at exactly the moment it matters — the findings have just been answered
 * and nothing has verified the answer. Measured: a lens-fix took the entire
 * remaining budget, the owed round was refused by this module's own start
 * gate, and the cycle capped with the fix unverified.
 *
 * Not an env knob: the reserve is the lens round's own floor, stated once as
 * `LENS_REVIEW_MIN_USEFUL_MS` (work-driver-deadline.ts) and read by the
 * round's start gate too — reserving less than a round's floor would reserve
 * a round that gets refused anyway, and a second literal would drift.
 */
export function lensRoundReserveMs(): number {
  return LENS_REVIEW_MIN_USEFUL_MS;
}

/**
 * #1242 / #1564 — each lens child's run bound: its own (30 min), shortened so
 * the wrap-up steer lands a grace before the loop budget runs out and the kill
 * at it. A round that crosses the cap ends there, its unfinished lanes
 * not-reviewed, instead of every lens running on past it.
 */
export function lensRoundChildBoundMs(state: WorkState, now: number): number {
  const own = lensChildBoundMs();
  const remaining = reviewRemainingMs(state, now);
  if (remaining === undefined) return own;
  return Math.min(own, Math.max(MIN_FIX_DISPATCH_MS, remaining - childBoundGraceMs()));
}
