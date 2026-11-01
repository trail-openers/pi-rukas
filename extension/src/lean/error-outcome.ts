/**
 * lean/error-outcome — the ONE outcome the engine records when a handler throws.
 *
 * A handler that throws is infrastructure, so the step records
 * `{kind: "error", message}` and the run ends handed-back. That record is also
 * the only place a failed step's cost can still be read: a dispatch that died
 * spent its tokens, and `state.ts` gives the four dispatching steps
 * (`specify`, `build`, `challenge`, `review`) a `dispatches` field for exactly
 * that (#1920 A). The steps therefore hand their rows back on the error itself —
 * `BuildInfraError`, `ChallengeInfraError` and `SpecifyInfraError` each carry a
 * `dispatches` array — and this module is what moves them onto the record.
 *
 * Two rules, both load-bearing:
 *
 *   - only a step that OWNS dispatches gets the field. An outcome carrying it
 *     on another state is refused at load by `OWNER_OF_FIELD` in
 *     `state-outcome.ts`, so writing one there would make the durable record
 *     of a run that hit this branch unreadable — the rows are dropped rather
 *     than the load broken;
 *   - the recorded rows are a product of the ONE validator, not a second one.
 *     `validatedDispatches` in `state-outcome.ts` rebuilds each row from its
 *     own checks; this module reads `dispatches` off an untrusted throw (a
 *     handler may throw anything) and hands it there, then clips the result to
 *     `DISPATCHES_MAX_ROWS`. A second local copy of the row rules would be a
 *     second definition of "a row the loader accepts", and the two drift.
 *
 * The clip keeps the TAIL: rows arrive in dispatch order, and the child that
 * ran last is the one that decided the step — dropping it to keep the first
 * rows would record a cost record that omits the expensive case.
 *
 * A leaf module: it imports no step and no engine type, so the engine stays
 * inside the size cap and the rules can be read — and tested — on their own.
 */

import { DISPATCHES_MAX_ROWS, DISPATCH_STATES, validatedDispatches } from "./state-outcome.ts";
import type { LeanState, Outcome } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/** What the engine records for one handler throw: a message, and rows when it has them. */
export type ErrorOutcome = Outcome & { kind: "error"; dispatches?: DispatchUsageRow[] };

/**
 * Which states may record what their children cost.
 *
 * Read from `DISPATCH_STATES` in `state-outcome.ts` — the one statement of that
 * set — rather than re-derived here. It used to be re-derived (`state ===
 * "review" || BUDGET_STATES.includes(state)`), which put a second expression of
 * the loader's own ownership rule on the throw path: a widening that landed on
 * one side and not the other dropped the run's most expensive numbers without a
 * sound, and nobody reading the state file afterwards could tell a step that cost
 * nothing from a field that was never allowed to land.
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
  return rows.length === 0
    ? { kind: "error", message }
    : { kind: "error", message, dispatches: rows };
}
