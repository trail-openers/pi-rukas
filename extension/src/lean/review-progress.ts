/**
 * lean/review-progress — the one predicate that decides whether a fix wave
 * achieved anything.
 *
 * Split from `review.ts`, which passed the size cap when `review-prompt.ts`
 * folded into it. Pure: it takes what a round reported and returns a verdict,
 * with no git, no tree and no dispatch in it. That separation is the point — the
 * step that consults it is the hardest part of `review` to read, and a rule that
 * can only be reasoned about inside it gets reasoned about wrongly.
 *
 * **It is the whole bound on the wave.** There is no round count to bound and no
 * stagnation tie-breaker: the wave has one fixer, so the case the tie-breaker
 * existed for — a gate that re-reports the same findings every round while a
 * fixer keeps committing — cannot recur, because there is no next round to buy.
 * What remains is the one way the wave is worth nothing on its own terms: the
 * fixer was dispatched, paid for, and changed nothing, so re-reviewing would
 * re-review the identical commit the gate just read, and a step that did that
 * would report a head it never actually looked at twice.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { ReviewInfraError } from "./review-errors.ts";
import { CAUSE_NO_CHANGE } from "./review-waves.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/**
 * The head a fix wave must have produced, or a throw naming why it did not.
 *
 * Three refusals, in the order a reader needs them: no head at all, the same
 * head (nothing was fixed), and a head that is not a commit this repo can check
 * out. The middle one carries {@link CAUSE_NO_CHANGE} verbatim: an empty fix
 * range is a named handback cause, never a pass and never a "the re-review found
 * nothing to look at" — the re-review is never dispatched for a wave that moved
 * nothing, which is what makes `noReview` unreachable downstream rather than
 * merely unlikely.
 */
export async function assertFixAdvanced(
  before: string,
  after: string | undefined,
  rows: DispatchUsageRow[],
): Promise<string> {
  // An integration that returned neither a head nor a stop is not a round that
  // worked; it is a step that cannot say what it did, and `""` would compare
  // unequal to `before` and sail through.
  if (after === undefined || after === "")
    throw new ReviewInfraError(
      `the fix wave reported no head and no budget stop — the step cannot tell what it did to ${before.slice(0, 12)}`,
      rows,
    );
  if (after === before)
    throw new ReviewInfraError(
      `${CAUSE_NO_CHANGE}: the fix wave left the branch at ${before.slice(0, 12)} — it fixed nothing, and re-reviewing an identical commit is a pass the run should not be given`,
      rows,
    );
  if (!isFullCommitSha(after))
    throw new ReviewInfraError(
      `the fix wave returned an unusable head ${JSON.stringify(after.slice(0, 40))}`,
      rows,
    );
  return after;
}
