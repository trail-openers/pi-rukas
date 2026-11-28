/**
 * The readings an errored `review` gets from the handback head rule (#2667), asked by
 * `lean/handback-heads.ts` once it has accepted the kind.
 *
 * A review that threw judged nothing, so over a head the run's own gate certified it has the same
 * standing a `fixed` review the gate has not spoken for has: the run owes that head the reporting
 * step's reading. The switch reads live here, so the rule and the fold consult one knob.
 *
 * The rule keys on the LOG and the switch, never on the stop cause. `lean/handback-heads.ts` owns
 * the base rule and its wordings: it hands this arm the gate's newest DECIDED `verify`, and a green
 * that named no commit keeps that file's own finding. This module imports NO lean file — the rule
 * asks it, never the other way round, so the two files cannot form an import cycle.
 */
import { isFullCommitSha } from "./commit-sha.ts";
import { leanReviewIncompleteHeadEnabled } from "./lean-review-incomplete-head-switch.ts";
import type { Outcome, Step } from "./lean/state.ts";

/** What the head rule answers for one log; the shape `lean/handback-heads.ts` declares. */
export interface IncompleteReviewHeads {
  applies: boolean;
  verifiedHead?: string;
  reason?: string;
}

/** Is this value a head the rule may name? The one shape test, for the rule and this arm. */
export function isVerifiedHeadName(head: unknown): head is string {
  return typeof head === "string" && isFullCommitSha(head);
}

/** Does the switch let an errored review be a handback shape at all? Read at CALL time. */
export function incompleteHeadOn(): boolean {
  return leanReviewIncompleteHeadEnabled();
}

/**
 * The reading an errored `review` gets, asked of the gate's newest decided verdict. `undefined`
 * means "this file has nothing to add", which is where the rule's own findings live.
 */
export function incompleteReviewHandback(
  green: Step | undefined,
): IncompleteReviewHeads | undefined {
  const outcome: Outcome | undefined = green?.outcome;
  if (outcome?.kind !== "green") return undefined;
  return isVerifiedHeadName(outcome.verifiedHead)
    ? { applies: true, verifiedHead: outcome.verifiedHead }
    : undefined;
}
