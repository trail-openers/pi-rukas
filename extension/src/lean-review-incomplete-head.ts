/**
 * The reading an errored `review` gets from the handback head rule (#2667), asked by
 * `lean/handback-heads.ts` once it has accepted the kind, and by `lean-report-route.ts` for the fold.
 *
 * A review that threw judged nothing, so over a head the run's own gate certified it has the same
 * standing a `fixed` review the gate has not spoken for has: the run owes that head the reporting
 * step's reading. The switch reads live here, so the rule and the fold consult one knob.
 *
 * `undefined` means "this file has nothing to add", and is the seam between the two readings: this file
 * speaks where a gate of this run was ANSWERED green, because a review that threw judged nothing and a
 * green verdict is what the run paid for. Whether that green NAMED a full commit sha decides the one thing
 * the two answers differ on: a named sha is the head a handback ships, and a green that named none applies
 * with no head — the report still runs, prints no head line and asks for no rewind. A verdict that was
 * never green, or a gate the run never let decide, belongs to the base rule in `lean/handback-heads.ts`,
 * whose own finding is the sentence that step printed before this knob existed.
 *
 * The switch reads live here, so the rule and the fold consult one knob. This module imports NO lean
 * file — the rule asks it, never the other way round, so the two files cannot form an import cycle.
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
 * The reading an errored `review` gets, asked of the gate's newest decided verdict.
 *
 * A green that NAMED a full commit sha is the certified arm: its head is what the report ships. A green
 * that ANSWERED and named none applies with no head and no reason: the report runs, writes no head field,
 * prints no head line, asks for no rewind, and its NEEDING line is the run's own sentence. Anything the
 * gate never certified — a verdict that was not green, or a gate the run never let decide — is
 * `{applies: false}`: a run whose gate named no bytes shipped nothing this step could ship, so it keeps
 * the plain stamp, byte for byte as before this knob existed.
 */
export function incompleteReviewHandback(green: Step | undefined): IncompleteReviewHeads {
  const outcome: Outcome | undefined = green?.outcome;
  if (outcome?.kind !== "green") return { applies: false };
  return isVerifiedHeadName(outcome.verifiedHead)
    ? { applies: true, verifiedHead: outcome.verifiedHead }
    : { applies: true };
}
