/**
 * adversarial-reviewer-grace — #2660's one spelling of a deadline-derived child-bound grace beside a
 * reviewer or lens child's bound. `adversarial-phase.ts` arms the reviewer's own spawn with it and
 * `lens-review-child.ts` arms each lens child with what the lens engine passed down; both seams
 * declare the field through {@link ReviewerBoundGraceOpt} instead of paying for it in their own line
 * budget (both sit at the 500-line gate).
 *
 * Why it has to travel at all: BOTH the adversarial loop and the lens engine BUILD their child's
 * spawn options rather than passing the step's arms through — `adversarial.ts` forwards it to
 * `makeRunPhase` beside `childBoundMs`, and `adversarial-phase.ts` / `lens-review-child.ts` hand it
 * to the spawn — and `spawn-child-bound.ts` answers a bound that arrives with no grace of its
 * own with the configured 10 minutes — so the kill lands a full grace past the deadline the bound was
 * placed against, the exact overrun #2660 was filed for. Absent means that configured grace, and,
 * like the bound, this only ever TIGHTENS it.
 *
 * It travels in ms, not minutes: `lean-step-bound.ts` floors a deadline-derived grace at
 * `MIN_KILL_GRACE_MS` (30 s) and derives the bound as `room − grace`, so a grace rounded elsewhere
 * moves the wrap-up steer off the position that bound was computed for. `childBoundSchedule` clamps
 * `bound + grace` against the cycle clock exactly once, whatever this says.
 */

/** #2660 — the step's deadline-derived child-bound grace, ms, beside `childBoundMs`. */
export interface ReviewerBoundGraceOpt {
  childBoundGraceMs?: number;
}

/** The spread arm for one spawn-options object: empty when the caller has no deadline-derived grace. */
export function reviewerBoundGrace(graceMs: number | undefined): ReviewerBoundGraceOpt {
  return graceMs === undefined ? {} : { childBoundGraceMs: graceMs };
}
