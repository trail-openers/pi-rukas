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
 * The clause naming a fixer whose last turn was cut at the output-token limit, appended to the
 * no-change cause when the wave spent its ONE continuation and the head still did not move.
 *
 * It is a SUFFIX rather than a different cause, and `CAUSE_NO_CHANGE` stays the sentence's head, for
 * two reasons: the cause is matched on all three surfaces that print it (this throw, the handback's
 * cause line, the headless `failure.message`), so a reader keyed on the existing phrase must keep
 * finding it; and the token count is the fact an operator needs in order to tell a model that hit its
 * provider's cap from a fixer that read everything and decided to change nothing. The clause sits at
 * the END of a cause this step's own renderer clips from the end, so it is short by construction and
 * pinned inside the kept span by the truncation suite.
 */
export function truncationClause(outputTokens: number): string {
  return ` — the fixer's last turn was cut off at the output-token limit (${String(
    outputTokens,
  )} tokens) before any edit, and one continuation changed nothing`;
}

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
  /** The cut this wave named, or `undefined` for a wave whose fixer simply changed nothing. Present
   *  only when the fixer's recorded stop reason was `"length"` with no write call AND the wave spent
   *  its continuation; a wave that never asked gets today's sentence, byte for byte. */
  truncated?: { outputTokens: number },
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
      `${CAUSE_NO_CHANGE}: the fix wave left the branch at ${before.slice(0, 12)} — it fixed nothing, and re-reviewing an identical commit is a pass the run should not be given${
        truncated === undefined ? "" : truncationClause(truncated.outputTokens)
      }`,
      rows,
    );
  if (!isFullCommitSha(after))
    throw new ReviewInfraError(
      `the fix wave returned an unusable head ${JSON.stringify(after.slice(0, 40))}`,
      rows,
    );
  return after;
}
