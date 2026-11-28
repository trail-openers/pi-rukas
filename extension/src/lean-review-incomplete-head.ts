/**
 * lean-review-incomplete-head — the reading an errored `review` gets at a handback (#2667).
 *
 * A review that THREW judged nothing, so over a head the run's own gate certified it has the same
 * standing a `fixed` review the gate has not spoken for has: the run owes that head the reporting
 * step's reading. Off the switch, or for any review kind outside the pair, the rule is silent
 * exactly as it was before the knob — an errored review is not a handback shape.
 *
 * The rule keys on the LOG and the switch, never on the stop cause; `lean/handback-heads.ts` owns
 * the base rule and calls this only once its own review arm is reached.
 */
import { leanReviewIncompleteHeadEnabled } from "./lean-review-incomplete-head-switch.ts";
import { type HandbackHeads, noVerifiedHead } from "./lean/handback-heads.ts";
import type { Step } from "./lean/state.ts";

/** Is this decided step an errored `review`? */
export function isErroredReview(step: Step): boolean {
  return step.state === "review" && step.outcome?.kind === "error";
}

/** Does the switch let an errored review be a handback shape at all? */
export function erroredReviewHandbackEnabled(): boolean {
  return leanReviewIncompleteHeadEnabled();
}

/**
 * The reading an errored review gets, once the base rule has accepted it. The rule's finding for a
 * certified green `verify` is `{applies: true, verifiedHead}`; `undefined` means the caller keeps
 * its own reading — a kind the base rule alone answers, or an errored review with nothing decided
 * behind it, which is not a handback over unverified bytes the run shipped.
 */
export function erroredReviewReading(green: Step | undefined): HandbackHeads | undefined {
  if (green === undefined) return { applies: false };
  if (green.outcome?.kind !== "green") return undefined;
  return noVerifiedHead(green.outcome.verifiedHead);
}
