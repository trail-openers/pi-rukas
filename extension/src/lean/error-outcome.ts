/**
 * lean/error-outcome — the ONE outcome the engine records when a handler throws.
 *
 * A handler that throws is infrastructure, so the step records `{kind: "error", message}` and the run ends
 * handed-back. That record is also the only place a failed step's cost can still be read: a dispatch that died
 * spent its tokens, and `state.ts` gives the four dispatching steps a `dispatches` field for exactly that. The
 * steps therefore hand their rows back on the error itself and this module is what moves them onto the record.
 *
 * Only a step that OWNS dispatches gets the field, and the rows are the product of the ONE validator rather
 * than a second local copy of the row rules.
 *
 * The clip keeps the TAIL: rows arrive in dispatch order, and the child that ran last is the one that decided
 * the step.
 *
 * A leaf module: it imports no step and no engine type.
 */

import {
  DISPATCHES_MAX_ROWS,
  validatedDispatches,
  validatedReviewBound,
} from "./state-dispatches.ts";
import { DISPATCH_STATES } from "./state-outcome.ts";
import type { LeanState, Outcome } from "./state.ts";

/** What the engine records for one handler throw: a message, and what it can prove. */
type ErrorOutcome = Outcome & { kind: "error" };

/**
 * Which states may record what their children cost. Read from `DISPATCH_STATES` in `state-outcome.ts` — the
 * one statement of that set — rather than re-derived here.
 */
function recordsDispatches(state: LeanState): boolean {
  return DISPATCH_STATES.includes(state);
}

/**
 * The outcome the engine records for a handler that threw `err` in `state`. A non-empty `message` always
 * survives; the rows are added only when both rules above hold.
 */
export function errorOutcome(state: LeanState, err: unknown): ErrorOutcome {
  const message = (err as Error)?.message ?? String(err);
  const rows = recordsDispatches(state)
    ? validatedDispatches((err as { dispatches?: unknown })?.dispatches).slice(-DISPATCHES_MAX_ROWS)
    : [];
  // A pass-1 step-clock stop has no verdict to carry its disclosure, so the throw holds it and the record is
  // the only place it can be read; the field belongs to `review` alone.
  const out: ErrorOutcome = { kind: "error", message };
  if (rows.length > 0) out.dispatches = rows;
  if (state === "review") {
    const bound = validatedReviewBound((err as { reviewBound?: unknown })?.reviewBound);
    if (bound !== undefined) out.reviewBound = bound;
  }
  return out;
}
