/**
 * work-driver-fix-pass-ceiling — the fix pass's pass-level fan-out verdict.
 *
 * Split from `work-driver-adversarial-fix-scope.ts`, which owns the per-file
 * admission ladder. The two are the pair of judgements one post-pass read makes
 * about one workstream, and they have to divide by the same number: the ladder
 * asks "may this file change at all" and this asks "has the pass changed too many
 * files to still be the work it was asked for" (the arithmetic itself is in
 * `work-driver-fix-pass-fanout.ts`). They stay separate files because their rules
 * are of different kinds; they are documented together because a pass bounded at
 * one number by the fence and another by this check is a pass bounded by two rules,
 * which is what PM decision #1846-3 removed.
 *
 * The #1849 item 9 defect this module's signature exists to prevent: this check
 * used to take the slot term as its own argument, read straight from the admitter,
 * while the ladder downstream carried `fence.ceiling` as `planFixPass` had built it
 * — with zero admitting slots, because a slot admits a file only once the pass
 * runs. So a workstream whose spec authorised a pattern slot could have a helper
 * file refused by a ceiling this check had already widened. Taking `judging` — the
 * SAME `FixPassFence` the ladder was judged against — and reading
 * `admittingSlots` off it makes the two judgements one arithmetic, and removes the
 * parameter a caller could get wrong.
 */

import type { FixPassFence } from "./work-driver-fix-pass-admission.ts";
import { fixPassFanoutRefusal } from "./work-driver-fix-pass-fanout.ts";

/**
 * The ceiling's refusal for one pass, or `undefined` when it is inside its bound.
 *
 * An undeclared (N=1) pass has no denominator to bound it with — there is nothing
 * declared to fan out FROM — so it returns `undefined` here rather than letting the
 * arithmetic produce a bound out of zero. That is the rule `postPassFault` states
 * at its own call site, kept with the function so the two cannot drift.
 *
 * `passFiles` is the numerator the ladder used: the pass's committed changes ∪ its
 * untracked files, both read against the pass's own pre-pass HEAD. Passing a
 * narrower set here (the pre-#1849 shape passed git's committed names only) let a
 * pass wander into untracked files without counting against the very ceiling the
 * fence had just enforced.
 */
export function passFanoutRefusal(
  id: string,
  declared: readonly string[],
  passFiles: readonly string[],
  judging: FixPassFence,
  admittedFiles: string[],
): string | undefined {
  if (declared.length === 0) return undefined;
  return fixPassFanoutRefusal(id, declared.length, passFiles, judging, {
    slotCount: judging.admittingSlots,
    admittedFiles,
  });
}
