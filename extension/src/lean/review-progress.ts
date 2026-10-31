/**
 * lean/review — the two predicates that decide whether a fix round achieved anything.
 *
 * Split from `review.ts`, which passed the size cap when `review-prompt.ts` folded
 * into it. Both are pure: they take what a round reported and return a verdict,
 * with no git, no tree and no dispatch in them. That separation is the point —
 * the loop that consults them is the hardest part of the step to read, and a
 * stagnation rule that can only be reasoned about inside it gets reasoned about
 * wrongly.
 *
 * **The two together are what bound the fix loop.** `MAX_REVIEW_ROUNDS` bounds the
 * number of rounds; these two refuse the two ways a round is worth nothing:
 *
 * - {@link assertFixAdvanced} — the head did not move. The fixer was dispatched,
 *   paid for, and changed nothing, so re-reviewing would re-review the identical
 *   commit the gate just read.
 * - {@link stagnantAgainstFix} — the head moved and the verdict did not. The fixer
 *   answered the round and the gate came back with the same findings anyway, which
 *   is what a deterministic gate does with a finding it cannot fix (out of scope,
 *   or unfisable without touching a frozen test the fixer's brief tells it to
 *   leave alone). Measured: a run whose fixer committed every round and whose
 *   adversarial gate always returned one finding dispatched fixers forever, because
 *   the round guard lives on the lens arm only and the adversarial arm had none.
 *
 * The order between them is load-bearing. `stagnantAgainstFix` requires
 * `from !== after`, so an unmoved head is `assertFixAdvanced`'s case and throws
 * first, with the truer sentence.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { ReviewInfraError } from "./review-errors.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/** What a fix round was asked to fix, and the head it started from. */
export type FixRequest = { gate: string; findings: string; from: string };

/**
 * Did the gate just repeat itself? True when the same gate hands back the same
 * findings text against a head the fix round moved.
 *
 * `from !== after` is the whole point of the check: a gate that reports identical
 * findings against an UNmoved head is the `assertFixAdvanced` case, which throws
 * first and says something truer. This one fires only when a fix landed and the
 * verdict did not change, which is the shape of a deterministic gate nobody will
 * ever satisfy by fixing the same thing again.
 */
export function stagnantAgainstFix(
  last: FixRequest | undefined,
  now: FixRequest,
  after: string,
): boolean {
  return (
    last !== undefined &&
    last.gate === now.gate &&
    last.findings === now.findings &&
    now.from !== after
  );
}

/**
 * The head a fix round must have produced, or a throw naming why it did not.
 *
 * Three refusals, in the order a reader needs them: no head at all, the same head
 * (nothing was fixed), and a head that is not a commit this repo can check out.
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
      `the fix round reported no head and no budget stop — the step cannot tell what it did to ${before.slice(0, 12)}`,
      rows,
    );
  if (after === before)
    throw new ReviewInfraError(
      `the fix round left the branch at ${before.slice(0, 12)} — it fixed nothing, and re-reviewing an identical commit is a round the run should not pay for`,
      rows,
    );
  if (!isFullCommitSha(after))
    throw new ReviewInfraError(
      `the fix round returned an unusable head ${JSON.stringify(after.slice(0, 40))}`,
      rows,
    );
  return after;
}
