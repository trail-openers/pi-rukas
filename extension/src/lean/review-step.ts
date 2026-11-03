/**
 * lean/review-step — the two judgements the `review` step makes about its OWN
 * cost, and nothing else.
 *
 * Split from `review.ts` for the 500-line cap (AGENTS.md §12), along the seam
 * this change created: `review.ts` is the loop (which verdict ends it, what a
 * fixer is told, when the bound says stop), and these two are about money —
 * what to say when the operator's ceiling stopped a child, and which of the
 * step's two kinds a pass carries. Neither needs the loop's state, and the loop
 * reads both through one import rather than growing their prose in its body.
 *
 * Both are pure, and both are leaves: `budgetStopped` throws the error
 * `review-errors.ts` already defines, and `passKind` is a two-value choice. A
 * leaf module is also what lets the budget stop stay a throw — importing the
 * handler to throw its error would be a cycle for the sake of one `throw`,
 * which is the same reason `review-errors.ts` and `review-progress.ts` exist.
 *
 * `REVIEW_STATE` is the name both the step and its log readers key on. It lives
 * in `review-log.ts`, beside the readers that cannot answer without it, and this
 * module imports it rather than restating the literal: two copies of "which
 * state is this" is two answers to that question.
 */

import { ReviewInfraError } from "./review-errors.ts";
import { REVIEW_STATE } from "./review-log.ts";
import type { BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { budgetSentence } from "./step-budget.ts";

/**
 * The cause for a child the operator's ceiling stopped, with the rows the step
 * paid for attached.
 *
 * The message IS `budgetSentence` — the one renderer of a breach, shared with
 * `handback`'s cause and the headless result's `failure.message` — and nothing
 * else. Every other step reports a breach as a `budget` outcome carrying the
 * typed `limit`/`value`/`used` trio, which is what those two readers build the
 * sentence FROM; `review` has no `budget` kind in the table, so the trio would be
 * fields no reader consults and the sentence is what this step can actually hand
 * back. A message of its own wording is how the three surfaces start disagreeing
 * about which lever fired.
 *
 * What rides on the error rather than in the message is the cost: the rows go to
 * `errorOutcome`, which puts them on the step record, and a handback that cannot
 * say what the stopped children cost understates the run.
 */
export function budgetStopped(fired: BudgetFired, rows: DispatchUsageRow[]): ReviewInfraError {
  return new ReviewInfraError(budgetSentence(REVIEW_STATE, fired), rows);
}

/**
 * The kind of a pass that cleared both gates: `fixed` when a fix round moved the
 * branch, `done` when it did not.
 *
 * The two kinds differ in one fact, and the whole routing difference hangs on
 * it: a fix round's `integrate` PUSHES, so the newest `verify` certifies a head
 * that is no longer the branch tip and `ci` refuses to look at it. The loop's own
 * count answers the question for the attempt that ran the round; `fixedFromLog`
 * answers it of the durable log for the one case the count cannot see — the
 * attempt that resumes after a crash, which remembers nothing and still stands on
 * a moved head.
 *
 * The return type is the pair the table routes on, written out rather than
 * derived: `machine.ts` has exactly these two kinds for `review` and a third
 * would be a route for an unreviewed head to reach `ci`, which
 * `test-lean-machine.ts` asserts as a property of the registry.
 */
export function passKind(fixed: boolean): "fixed" | "done" {
  return fixed ? "fixed" : "done";
}
