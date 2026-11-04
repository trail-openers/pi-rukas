/**
 * dispatch-budget-params — the PM-callable bounds of #1991, and what they arm.
 *
 * `dispatch_specialist` and `dispatch_parallel` both take `maxTurns` and
 * `maxMinutes`. Until now a PM could only write a time-box into the brief and
 * hope: a child never saw its own budget, so a 60-minute brief ran 80 minutes
 * and a 400-turn build child was killed at 401 with nothing committed. Passing
 * the bound here means the child is told where it stands at half and again at
 * close-out (budget-progress.ts), which is the half of the fix that costs the
 * child nothing.
 *
 * What the two levers actually do differs, and the difference is honest
 * doctrine rather than a subtlety: `maxMinutes` arms `childBoundMs`, the real
 * per-child wall clock (`spawn-child-bound.ts` steers it to wrap up, then ends
 * it). `maxTurns` is the denominator the progress steer reports against — the
 * turn count that ends a child is the caller's abort (as in `lean`'s
 * `armBudget`, which turns a turns breach into an `AbortController`), not a
 * spawn-side kill. So `maxTurns` paces; `maxMinutes` paces and stops.
 *
 * Validation is strict and refuses at the tool boundary: a bound the child
 * never got is worse than no bound, because the PM believes it armed one. A
 * non-integer (`1.5`), a string (`"20"`), a zero, or a value past the ceiling
 * all throw with the range in the message, so the model reads the fix rather
 * than guessing. Absent means no bound, exactly as before this parameter —
 * which is why `undefined` is the only value that may pass through untouched.
 */

import { childBoundGraceMs } from "./spawn-child-bound.ts";
import { spawnBackstopMs } from "./spawn-support.ts";

/** Turn ceiling: above it a "bound" is a backstop, not a budget, and Pi's own
 *  retry arithmetic stops being meaningful to report as a fraction. */
export const MAX_TURNS_LIMIT = 1000;
/** The largest `maxMinutes` whose bound can still end a child: the spawn's
 *  wall-clock backstop, less the wrap-up grace the bound spends before its
 *  kill. Past that the 2-h backstop ends the child first, so the bound is a
 *  number the PM believes it armed and the runtime never enforces — which is
 *  the one thing this module's validation exists to refuse. Read per call so an
 *  operator who lowers `PI_ENSEMBLE_SPAWN_TIMEOUT_MS` does not keep a ceiling
 *  that admits unreachable bounds. */
export function maxMinutesLimit(): number {
  return Math.max(1, Math.floor((spawnBackstopMs() - childBoundGraceMs()) / 60_000));
}
/** The shipped default ceiling for the TypeBox descriptions, which are built
 *  once at tool-registration and so cannot read a live knob: the spawn's 2-h
 *  wall-clock backstop, less the 10-min wrap-up grace the bound spends before
 *  its kill → 110 minutes. `maxMinutesLimit()` is the live form the parse uses
 *  and the one tests pin. */
const DEFAULT_MAX_MINUTES_LIMIT = Math.floor((2 * 60 * 60_000 - 10 * 60_000) / 60_000);

/** One accepted value, or the sentence that refuses it. */
function validate(name: string, value: unknown, ceiling: number, unit: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw new Error(
      `${name} must be a whole number of ${unit} between 1 and ${String(ceiling)} (got ${JSON.stringify(value)}).`,
    );
  }
  if (value < 1 || value > ceiling) {
    throw new Error(
      `${name} must be between 1 and ${String(ceiling)} ${unit} (got ${String(value)}).`,
    );
  }
  return value;
}

/** `maxTurns` for one spec's parameter object. Throws on anything not accepted. */
export function parseMaxTurns(value: unknown): number | undefined {
  return validate("maxTurns", value, MAX_TURNS_LIMIT, "turns");
}

/** `maxMinutes` for one spec's parameter object, in ms for `childBoundMs`. */
export function parseMaxMinutes(value: unknown): number | undefined {
  const minutes = validate("maxMinutes", value, maxMinutesLimit(), "minutes");
  return minutes === undefined ? undefined : minutes * 60_000;
}

/** TypeBox descriptions, kept here so both tools state the same range and the
 *  same consequence, and a reader finds one definition rather than two. */
export const MAX_TURNS_DESCRIPTION = `Optional turn bound, an integer from 1 to ${String(
  MAX_TURNS_LIMIT,
)}. It paces only: the child is steered at 50% and 80% of it ("turn 20 of 40"), the 80% line telling it to commit (developer) or report its findings (every other role). It does NOT end the child — nothing kills at the turn bound. Use maxMinutes for a bound that stops the child.`;
export const MAX_MINUTES_DESCRIPTION = `Optional wall-clock bound, an integer from 1 to ${String(
  DEFAULT_MAX_MINUTES_LIMIT,
)} minutes. It paces and it stops: the child is steered at 50% and 80% of it with the minutes it has left, then steered to wrap up at the bound and ENDED once the wrap-up grace runs out — unless it committed or reported, in which case it is ended as done. A bound past what the spawn's wall-clock backstop grants is refused.`;
