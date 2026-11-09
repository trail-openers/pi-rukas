/**
 * lean/error-outcome — the ONE outcome the engine records when a handler throws.
 *
 * A handler that throws is infrastructure, so the step records
 * `{kind: "error", message}` and the run ends handed-back. That record is also
 * the only place a failed step's cost can still be read: a dispatch that died
 * spent its tokens, and `state.ts` gives the four dispatching steps
 * (`specify`, `build`, `challenge`, `review`) a `dispatches` field for exactly
 * that. The steps therefore hand their rows back on the error itself —
 * `BuildInfraError`, `ChallengeInfraError` and `SpecifyInfraError` each carry a
 * `dispatches` array — and this module is what moves them onto the record.
 *
 * Only a step that OWNS dispatches gets the field (`OWNER_OF_FIELD` refuses the
 * others at load, so a stray one is dropped rather than breaking the record), and
 * the rows are the product of the ONE validator rather than a second local copy of
 * the row rules: this module reads `dispatches` off an untrusted throw and hands it
 * to `validatedDispatches`, then clips to `DISPATCHES_MAX_ROWS`.
 *
 * The clip keeps the TAIL: rows arrive in dispatch order, and the child that
 * ran last is the one that decided the step — dropping it to keep the first
 * rows would record a cost record that omits the expensive case.
 *
 * A leaf module: it imports no step and no engine type, so the engine stays
 * inside the size cap and the rules can be read — and tested — on their own.
 */

import { validatedReviewBound } from "./state-dispatches.ts";
import { DISPATCHES_MAX_ROWS, DISPATCH_STATES, validatedDispatches } from "./state-outcome.ts";
import type { LeanState, Outcome, ReviewBoundRecord } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/** What the engine records for one handler throw: a message, and what it can prove. */
type ErrorOutcome = Outcome & { kind: "error" };

/**
 * Which states may record what their children cost. Read from `DISPATCH_STATES` in
 * `state-outcome.ts` — the one statement of that set — rather than re-derived here: a second
 * expression of the loader's ownership rule on the throw path would let a widening land on one side
 * and silently drop the run's most expensive numbers.
 */
function recordsDispatches(state: LeanState): boolean {
  return DISPATCH_STATES.includes(state);
}

/**
 * The outcome the engine records for a handler that threw `err` in `state`.
 * A non-empty `message` always survives; the rows are added only when both
 * rules above hold.
 */
export function errorOutcome(state: LeanState, err: unknown): ErrorOutcome {
  const message = (err as Error)?.message ?? String(err);
  const rows = recordsDispatches(state)
    ? validatedDispatches((err as { dispatches?: unknown })?.dispatches).slice(-DISPATCHES_MAX_ROWS)
    : [];
  // A pass-1 step-clock stop has no verdict to carry its disclosure, so the throw
  // holds it and the record is the only place it can be read; `OWNER_OF_FIELD` gives
  // the field to `review` alone, so no other step's throw can put one on the run.
  const out: ErrorOutcome = { kind: "error", message };
  if (rows.length > 0) out.dispatches = rows;
  if (state === "review") {
    const bound = validatedReviewBound((err as { reviewBound?: unknown })?.reviewBound);
    if (bound !== undefined) out.reviewBound = bound;
  }
  return out;
}
