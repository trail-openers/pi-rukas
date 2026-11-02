/**
 * lean/review — the error a review step throws when the infrastructure failed.
 *
 * A leaf module: it imports only the row type and the cap, so `review.ts`,
 * `review-progress.ts` and the smoke fixtures can all throw it without one of them
 * importing the step's handler. It used to live in `review.ts`, which meant any
 * extracted predicate that needed to refuse something had to import the whole
 * handler back — a cycle for the sake of one `throw`.
 *
 * **A `ReviewInfraError` is not a verdict.** The step's verdicts are `done` and the
 * routed budget `Outcome`; this error means the step could not form a verdict at
 * all (a gate that produced none, a fixer that died, a tree it could not make). The
 * engine records it through `errorOutcome`, and the distinction is what keeps "the
 * review found nothing wrong" from being reachable by an error path.
 */

import { DISPATCHES_MAX_ROWS } from "./state-outcome.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

export class ReviewInfraError extends Error {
  override readonly name = "ReviewInfraError";
  constructor(message: string, rows: DispatchUsageRow[] = []) {
    super(message);
    // CLIPPED HERE, once, rather than at each of the fifteen throw sites. Every
    // `rows` in this step accumulates across the whole step, so a late throw
    // carries every earlier round's children; past the validator's cap the loader
    // does not reject the record, it DROPS the `dispatches` field, which silently
    // un-bills the step's most expensive child. The tail is kept, so the child
    // that decided the outcome is always among the rows the operator is handed —
    // the same rule `error-outcome.ts` applies on the way out and the `done`
    // return in `review.ts` applies on the way in.
    this.dispatches = rows.slice(-DISPATCHES_MAX_ROWS);
  }
  readonly dispatches: DispatchUsageRow[];
}
