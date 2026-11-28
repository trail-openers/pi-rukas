/**
 * The reading an errored `review` gets from the handback head rule (#2667), asked by
 * `lean/handback-heads.ts` once it has accepted the kind, and by `lean-report-route.ts` for the fold.
 *
 * A review that threw judged nothing, so over a head the run's own gate certified it has the same
 * standing a `fixed` review the gate has not spoken for has: the run owes that head the reporting
 * step's reading. The switch reads live here, so the rule and the fold consult one knob.
 *
 * `undefined` means "this file has nothing to add", and is the seam between the two readings: this file
 * speaks only where a gate of this run certified BYTES — a green that named a full commit sha — because
 * those are the only bytes a handback can ship. Every other verdict (a green that named none, a red, a
 * gate the run never let decide) belongs to the base rule in `lean/handback-heads.ts`, whose own finding
 * is the sentence the step printed before this knob existed.
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
 * The reading an errored `review` gets, asked of the gate's newest decided verdict. `undefined` is the
 * hand-back to the base rule: only a green that NAMED a full commit sha is bytes a handback can ship,
 * and only that answer is this file's. Everything the gate left uncertified is the base rule's finding.
 */
export function incompleteReviewHandback(green: Step | undefined): IncompleteReviewHeads | undefined {
  const outcome: Outcome | undefined = green?.outcome;
  if (outcome?.kind !== "green") return undefined;
  return isVerifiedHeadName(outcome.verifiedHead)
    ? { applies: true, verifiedHead: outcome.verifiedHead }
    : undefined;
}
