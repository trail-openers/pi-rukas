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

/** Turn ceiling: above it a "bound" is a backstop, not a budget, and Pi's own
 *  retry arithmetic stops being meaningful to report as a fraction. */
export const MAX_TURNS_LIMIT = 1000;
/** Minute ceiling: four hours, the same ceiling the reviewer bound knob uses,
 *  and past it the 2-h spawn backstop would end the child before its bound. */
export const MAX_MINUTES_LIMIT = 240;

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
  const minutes = validate("maxMinutes", value, MAX_MINUTES_LIMIT, "minutes");
  return minutes === undefined ? undefined : minutes * 60_000;
}

/** TypeBox descriptions, kept here so both tools state the same range and the
 *  same consequence, and a reader finds one definition rather than two. */
export const MAX_TURNS_DESCRIPTION = `Optional turn bound, an integer from 1 to ${String(
  MAX_TURNS_LIMIT,
)}. The child is steered at half of it and again at 80% ("turn 20 of 40") telling it to commit (developer) or report its findings (every other role) before the bound ends it.`;
export const MAX_MINUTES_DESCRIPTION = `Optional wall-clock bound, an integer from 1 to ${String(
  MAX_MINUTES_LIMIT,
)} minutes. The child is steered at half of it and at 80% with the minutes it has left; at the bound it is steered to wrap up and then ended.`;
