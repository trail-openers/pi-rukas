/**
 * lean/review — the error a review step throws when the infrastructure failed.
 *
 * A leaf module: it imports only the row type and the cap, so `review.ts`,
 * `review-progress.ts` and the smoke fixtures can all throw it without one of them
 * importing the step's handler. It used to live in `review.ts`, which meant any
 * extracted predicate that needed to refuse something had to import the whole
 * handler back — a cycle for the sake of one `throw`.
 *
 * **A `ReviewInfraError` is not a verdict.** The step's verdicts are its two
 * routed kinds — `done` (both gates cleared untouched) and `fixed` (a fix round
 * moved the head) — and this error means the step could not form a verdict at all
 * (a gate that produced none, a fixer that died, a tree it could not make, the
 * operator's budget stopping a child, which this step throws rather than routes).
 * The engine records it through `errorOutcome`, and the distinction is what keeps
 * "the review found nothing wrong" from being reachable by an error path.
 */

import { clippedDispatches } from "./dispatches-clip.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

export class ReviewInfraError extends Error {
  override readonly name = "ReviewInfraError";
  constructor(message: string, rows: DispatchUsageRow[] = []) {
    super(message);
    // CLIPPED HERE, once, rather than at each of the fifteen throw sites, by the
    // one clipper `clippedDispatches` — every `rows` in this step accumulates
    // across the whole step, so a late throw carries every earlier round's
    // children. Past the validator's cap `assertRunFile` throws `LeanStateError`
    // on the record, which leaves the run's whole state file unreadable rather
    // than merely un-billed. The tail is kept, so the child that decided the
    // outcome is always among the rows the operator is handed.
    this.dispatches = clippedDispatches(rows) ?? [];
  }
  readonly dispatches: DispatchUsageRow[];
}
