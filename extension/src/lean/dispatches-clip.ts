/**
 * lean/dispatches-clip — the ONE statement of how a step's dispatch rows are
 * clipped to what the durable record may hold.
 *
 * It is a leaf on purpose: it reads the row type and nothing else, so any module
 * in the `state-*` cluster — and any step — can take the clip without importing
 * the validator, the outcome fold, or the store back. That is not a stylistic
 * preference. When this rule lived in `state-dispatches.ts` alongside the row
 * validators, a caller that wanted only the clip pulled in the whole validator
 * pair, and the `state-outcome` ↔ `state-outcome-maps` re-export cycle became a
 * load-order failure at module evaluation rather than a hypothetical.
 *
 * The rule, and why each half is load-bearing:
 *
 *   - **The TAIL is kept.** Rows arrive in dispatch order, so the child that ran
 *     last is the one that decided the step. A head-keeping clip would bill the
 *     earliest children and drop the expensive one that stopped the step.
 *   - **An empty list yields `undefined`, not `[]`.** An empty key on the durable
 *     record says "this step paid for zero children" where the truth is "this step
 *     is not one that dispatches", and the fold cannot tell the two apart.
 *   - **Over the cap is fatal, not cosmetic.** `dispatchesProblem` refuses an
 *     over-long array and `assertRunFile` throws `LeanStateError` on that refusal
 *     with no catcher on the load path, so the run's whole state file becomes
 *     unreadable. (Per-row DROPPING is a different contract on a different
 *     function: `validatedDispatches` in `state-dispatches.ts` `continue`s past a
 *     row it refuses. The two must not be read as one.)
 */
import type { DispatchUsageRow } from "./step-budget.ts";

/**
 * The rows a step may persist, clipped to {@link DISPATCHES_MAX_ROWS} by keeping
 * the tail, or `undefined` when there are none.
 */
export function clippedDispatches(rows: DispatchUsageRow[]): DispatchUsageRow[] | undefined {
  if (rows.length === 0) return undefined;
  return rows.length > DISPATCHES_MAX_ROWS ? rows.slice(-DISPATCHES_MAX_ROWS) : rows;
}

/**
 * How many dispatch rows one step may record. Declared here, at the bottom of a
 * dependency-free module, because the clip needs it and must not reach up into
 * the validator pair for it. `state-dispatches.ts` — which owns the row rules
 * that enforce it — re-exports it so a reader of the validator sees the bound
 * beside the code that enforces it, and every existing importer keeps spelling
 * it from there.
 */
export const DISPATCHES_MAX_ROWS = 16;
