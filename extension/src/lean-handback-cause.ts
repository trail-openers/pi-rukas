/**
 * lean-handback-cause — what a handback comment says the run ended on (#2667).
 *
 * The reporting step's NEEDING line is a reading of the step log, and the errored-review arm is
 * the shape that had no line at all: the throw's own record is an `error` outcome, not a verdict,
 * and the operator needs the two facts apart — the step never finished, and here is what stopped
 * it. `lean/handback.ts` owns the comment and the order of causes; this module owns the one
 * reading the review throw adds.
 */
import { newestDecidedWorkStep } from "./lean/handback-heads.ts";
import type { Step } from "./lean/state.ts";

/**
 * The two "no verified head" findings the reporting step quotes, and the reading an errored `review`
 * gets from the head rule. The wordings live here, outside the lean tree, so the lean reader stays a
 * thin caller: it hands these readers the gate's newest DECIDED verdict and the newest unanswered
 * gate visit, and quotes what comes back. The switch reads through `incompleteHeadOn`, so the rule,
 * the routing and the fold consult one knob.
 */
import { incompleteHeadOn, isVerifiedHeadName } from "./lean-review-incomplete-head.ts";

/** The only places those answers are worded; the reporting step quotes a finding, never re-words it. */
export const NO_GATE_VERDICT =
  "no verify step of this run decided anything, so no head is verified";

/**
 * What the head rule answers for one log; the shape `lean/handback-heads.ts` declares. True when this
 * handback stands over bytes no gate of this run certified: a `fixed` review the gate has not spoken for
 * since (a gate visit ENTERED and never answered counts as not speaking), an errored review over a head
 * the gate certified — a review that threw judged nothing, so its head is owed the same reading — or a
 * draft publish whose own head no green covers.
 */
export interface HandbackFindings {
  applies: boolean;
  /** The newest decided green `verify`'s head at or before the newest work step; none when absent. */
  verifiedHead?: string;
  /** Why nothing is shipped, in the finding's own words, when there is no head to ship. */
  reason?: string;
  /** The draft-publish arm's own claim, set only for that arm: the head publish pushed, unverified. */
  shippedHead?: string;
  shippedVerified?: false;
}

/**
 * The base rule's findings for a `fixed` review the gate has not spoken for: an unanswered re-visit is
 * the shape the rule must refuse to ship over, and a gate that never answered at all gets
 * {@link NO_GATE_VERDICT}. A green that NAMED a commit is the head a handback ships; a green that named
 * none, and a verdict that was not green, say so here rather than name a head the run cannot prove.
 */
export function gateFindings(
  green: Step | undefined,
  unanswered: Step | undefined,
): HandbackFindings {
  if (unanswered !== undefined)
    return {
      applies: true,
      reason: `the run entered the gate again at ${unanswered.key} and never recorded what it decided, so no head is verified`,
    };
  if (green === undefined) return { applies: true, reason: NO_GATE_VERDICT };
  const kind = green.outcome?.kind;
  if (kind !== "green")
    return {
      applies: true,
      reason: `the newest decided verify is ${String(kind)}, not green, so no head is verified`,
    };
  const head = green.outcome?.verifiedHead;
  return isVerifiedHeadName(head)
    ? { applies: true, verifiedHead: head }
    : {
        applies: true,
        reason: "the green verify recorded no head, so there is no verified head to ship",
      };
}

/**
 * The reading an errored `review` gets, asked of the gate's newest DECIDED verdict. Off, the kind is
 * refused here exactly as it was before the knob existed. A green that NAMED a full commit sha is the
 * certified arm and its head is what the report ships; a green that ANSWERED and named none applies with
 * no head and no reason, so the report runs, writes no head field, prints no head line, asks for no
 * rewind, and its NEEDING line is the run's own sentence. Anything the gate never certified — a verdict
 * that was not green, or a gate the run never let decide — is silent: a run whose gate named no bytes
 * shipped nothing this step could ship, so it keeps the plain stamp the engine writes where it stands.
 */
export function erroredReviewFindings(green: Step | undefined): HandbackFindings {
  if (!incompleteHeadOn()) return { applies: false };
  if (green?.outcome?.kind !== "green") return { applies: false };
  return isVerifiedHeadName(green.outcome.verifiedHead)
    ? { applies: true, verifiedHead: green.outcome.verifiedHead }
    : { applies: true };
}

/**
 * The cause the run ended on, for the ONE shape that had no cause line at all: a `review` step that THREW
 * and whose run was STAMPED where it stood. Its record is an error outcome, not a verdict, and the operator
 * needs the two facts apart — the step never finished, and here is what stopped it. The sentence under the
 * heading is the throw's, unedited.
 *
 * Two exclusions, both load-bearing. A step that ended the run with a VERDICT is not this reading's
 * subject: a red `verify` or `ci` already spoke for itself, and quoting it under a review heading buries
 * the answer a developer can act on. And a review throw the engine ROUTED into the reporting step is not
 * either: that step runs with its own visit in the log, quotes the throw verbatim as the run's cause, and
 * needs no heading over its own words — only the stamped run, which gets no step at all, has a cause
 * nobody said.
 */
export function endedBy(steps: Step[]): string | undefined {
  const ended = newestDecidedWorkStep(steps);
  if (ended?.state !== "review" || ended.outcome?.kind !== "error") return undefined;
  if (steps.some((s) => s.state === "handback" || s.state === "decline")) return undefined;
  const reason = ended.outcome.message ?? ended.outcome.reason;
  if (typeof reason !== "string" || reason.trim() === "") return undefined;
  // A bare engine error is not a handoff because nobody said which step owed the work; this says so,
  // once. The clause is stated one time with the reason after it, never twice around it.
  return `the review did not complete: ${reason}`;
}
