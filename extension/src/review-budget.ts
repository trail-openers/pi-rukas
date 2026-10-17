/**
 * review-budget — the two review-loop time ceilings, and the only place they
 * are stated (#1429).
 *
 * Before this module the 90-minute review budget existed as TWO hardcoded
 * constants that no knob reached, plus a string literal:
 *
 *   - `REVIEW_WALL_CLOCK_MS` in `work-driver-context.ts`, read by the driver's
 *     `nextStep`, the lens-cap check, the fix-dispatch bound and `/work-status`;
 *   - `const REVIEW_CAP_MS` in `review-cap.ts`, the answer `check_review_cap`
 *     gives agents, restated in that tool's own description;
 *   - `` `cap ${capElapsed}/90m` `` in `work-widget.ts` — a literal, so no
 *     helper could have moved it, and the surface the operator actually reads.
 *
 * That last one is why a single-knob fix would not have worked: an operator
 * who tuned the driver would still have seen `…/90m` in the footer and `cap is
 * 90 minutes` from the tool. Both constants and the literal move together here,
 * so there is exactly one statement of each ceiling and every renderer reads
 * the resolved value.
 *
 * Two variables, deliberately not one:
 *
 *   - `PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS` bounds the *fixer dispatch* inside
 *     the driver (how long `lens-fix` and the adversarial fix pass may run);
 *   - `PI_ENSEMBLE_REVIEW_CAP_MS` is the ceiling the `check_review_cap` tool
 *     reports and answers `ok: false` past.
 *
 * They default to the same 90 minutes and historically shared one number, but
 * they are different ceilings with different consumers — one is a kill, the
 * other an advisory answer an agent acts on. Merging them into a single knob
 * would mean tuning the tool's prose silently changes when the driver kills a
 * child, which is the same coupling this repo keeps apart everywhere else
 * (`lens-round-cap.ts` vs `MAX_REVIEW_ROUNDS` is the analogue).
 *
 * Both are read PER CALL, following `lensRoundCap()` (`lens-round-cap.ts`) and
 * `reviewEnforceEnabled()` (`work-driver-lens-fix-budget.ts`) — whose comment
 * states the reason: "Process env is read per call so tests can flip it". A
 * module-load read would freeze the value at import and make the knob
 * untestable.
 *
 * Orthogonality, which is load-bearing: this module only ever *bounds* the
 * ceiling. Removing enforcement is `PI_ENSEMBLE_REVIEW_ENFORCE=0`, which is
 * read by `reviewEnforceEnabled()` and bypasses the checks entirely. Setting
 * a wall clock here never disables enforcement, and disabling enforcement
 * never changes the number the widget and `/work-status` print.
 */

import { trace } from "./trace.ts";

/** Default wall-clock cap for the fix loop (lens-review → developer-fix →
 *  adversarial → re-review): 90 minutes, the value every surface showed before
 *  #1429 and the value all of them still show when the knob is unset. */
export const REVIEW_WALL_CLOCK_MS = 90 * 60 * 1000;

/** Default ceiling for the `check_review_cap` tool: 90 minutes, as before. */
export const REVIEW_CAP_DEFAULT_MS = 90 * 60 * 1000;

/** The operator knob for the driver's review-loop wall clock. */
export const REVIEW_WALL_CLOCK_ENV = "PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS";

/** The operator knob for the `check_review_cap` ceiling. */
export const REVIEW_CAP_ENV = "PI_ENSEMBLE_REVIEW_CAP_MS";

/**
 * The shortest review-loop budget the harness honours (10 minutes) — the
 * CLAMP both knobs apply.
 *
 * `reviewFixDispatchBoundMs` distinguishes `remaining <= 0` (arm a minimal
 * bound, because unbounded is the bug) from
 * `remaining <= MIN_FIX_DISPATCH_MS + handoffDispatchTimeoutMs()` (do not
 * start a fixer at all). A ceiling below the handoff grace leaves no interval
 * in which a fixer may be armed: every dispatch lands in one of those two
 * branches, so a well-meaning `PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS=30000` would
 * have silently disabled every bound instead of tightening it.
 *
 * Chosen: REJECT and fall back to the default, with a trace naming the
 * rejected value — rather than clamp up to the floor. A value the operator
 * did not write should never be silently obeyed as if it had been; the round
 * cap follows the same rule ("a typo must never silently disable the budget"),
 * and a fallback that is loudly traced is easier to debug than a clamp that
 * quietly moves 30 s to 10 m. The floor is also comfortably above the 8-minute
 * default handoff grace, so any value that passes is one the arithmetic can
 * actually honour.
 */
export const MIN_REVIEW_BUDGET_MS = 10 * 60 * 1000;

/**
 * Resolve one ms knob: a positive integer at or above `MIN_REVIEW_BUDGET_MS`,
 * or `dflt`. Shared by both knobs so they cannot drift in validation.
 *
 * Non-integer, zero, negative, blank, non-numeric and below-floor values all
 * return `dflt` and trace the rejected raw value.
 */
function resolveMs(name: string, raw: string | undefined, dflt: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return dflt;
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= MIN_REVIEW_BUDGET_MS) return n;
  trace(
    `review-budget: ignoring ${name}=${trimmed} — not an integer of at least ${MIN_REVIEW_BUDGET_MS}ms; using the ${dflt / 60_000}-minute default`,
  );
  return dflt;
}

/**
 * The driver's review-loop wall clock in force. Read per call; see the module
 * header for why, and `MIN_REVIEW_BUDGET_MS` for the clamp.
 */
export function reviewWallClockMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMs(REVIEW_WALL_CLOCK_ENV, env[REVIEW_WALL_CLOCK_ENV], REVIEW_WALL_CLOCK_MS);
}

/** The `check_review_cap` ceiling in force. Read per call. */
export function reviewCapMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMs(REVIEW_CAP_ENV, env[REVIEW_CAP_ENV], REVIEW_CAP_DEFAULT_MS);
}
