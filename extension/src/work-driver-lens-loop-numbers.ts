/**
 * work-driver-lens-loop-numbers — the two numbers the review loop's budget
 * shares, in the LEAF module both sides of the loop can import.
 *
 * #1789 — `work-driver-lens-fix-budget.ts` and `work-driver-lens-round-budget.ts`
 * used to import each other: the fixer's bound needed the round's reserve
 * (`lensRoundReserveMs`), and the round's child bound needed the fixer's floor
 * (`MIN_FIX_DISPATCH_MS`) and the budget read (`reviewRemainingMs`). A cycle
 * between two modules is how a shared constant silently changes meaning
 * depending on which file a reader opened first, so the shared primitives live
 * here and each side imports the leaf. Nothing in this file imports a loop
 * module; that is its whole purpose.
 */

import { childBoundGraceMs, lensChildBoundMs } from "./spawn-child-bound.ts";
import { LENS_REVIEW_MIN_USEFUL_MS } from "./work-driver-deadline.ts";
import type { WorkState } from "./workflow-state.ts";

/** The least bound armed on a fix-loop dispatch: with the budget spent, the
 *  develop fix pass (which has no park of its own) is not left unbounded —
 *  that is the bug — nor killed at once; it is killed with the structured
 *  `timeout` killCause and the step fails through the normal router. */
export const MIN_FIX_DISPATCH_MS = 60_000;

/**
 * #1742 — the slice of the loop budget a fixer may never spend: the minimum
 * a lens round needs to be worth starting (`MIN_USEFUL_MS["lens-review"]`).
 *
 * A committed fix OWES a re-review: the loop's contract is fix → re-review,
 * and a budget that lets the fixer spend everything but the re-review breaks
 * it at exactly the moment it matters — the findings have just been answered
 * and nothing has verified the answer. Measured: a lens-fix took the entire
 * remaining budget, the owed round was refused by the round's own start
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

/** The loop budget left, or `undefined` when no review clock has started (a
 *  cycle that has not reached lens-review) or enforcement is off. `readClock`
 *  is injected rather than imported: the budget module owns the env knob and
 *  the elapsed arithmetic, and this leaf must not import it — that import is
 *  the cycle this module exists to break. */
export function remainingFromClock(
  state: WorkState,
  now: number,
  readClock: (state: WorkState, now: number) => number | undefined,
  wallClockMs: number,
): number | undefined {
  const elapsed = readClock(state, now);
  return elapsed === undefined ? undefined : wallClockMs - elapsed;
}

/**
 * #1242 / #1564 — each lens child's run bound: its own (30 min), shortened so
 * the wrap-up steer lands a grace before the loop budget expires and the kill
 * at it. A round that crosses the cap ends there, its unfinished lanes
 * not-reviewed, instead of every lens running on past it.
 */
export function lensRoundChildBoundFromRemaining(remaining: number | undefined): number {
  const own = lensChildBoundMs();
  if (remaining === undefined) return own;
  return Math.min(own, Math.max(MIN_FIX_DISPATCH_MS, remaining - childBoundGraceMs()));
}
