/**
 * lean/handback-heads — the one reading of the step log that says whether a handback is
 * standing over unverified bytes, and which head it should ship.
 *
 * The rule keys on the LOG, not the stop cause. Two edges put unverified bytes on origin's branch while the
 * run walks: a `review` step whose fix wave pushed (`machine.ts` routes `fixed` back through `verify`, so a
 * run reaching `handback` over a `fixed` review with no decided `verify` behind it never ran that
 * re-verification), and the `build + exhausted` draft publish.
 *
 * "We know a head we can ship" is a different claim from "the run once saw a gate": the newest DECIDED
 * `verify` must be `green` and must name a head.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import {
  erroredReviewHandbackEnabled,
  erroredReviewReading,
  isErroredReview,
} from "../lean-review-incomplete-head.ts";
import { type LeanState, REPORT_STATES, type Step } from "./state.ts";

/**
 * What the operator asks of a head that shipped unverified is why it never got certified. The only place
 * that answer is worded; `handback.ts` quotes the finding rather than re-wording it.
 */
export const NO_GATE_VERDICT =
  "no verify step of this run decided anything, so no head is verified";

/**
 * True when this handback stands over bytes no gate of this run certified: a `fixed` review the gate has not
 * spoken for since (a gate visit ENTERED and never answered counts as not speaking), an errored review over a
 * head the gate certified — a review that threw judged nothing, so its head is owed the same reading — or a
 * draft publish whose own head no green covers. The errored arm's reading lives in
 * `../lean-review-incomplete-head.ts`.
 */
export interface HandbackHeads {
  applies: boolean;
  /** The newest decided green `verify`'s head at or before the newest work step; none when absent. */
  verifiedHead?: string;
  /** Why nothing is shipped, in the record's own words, when there is no head to ship. */
  reason?: string;
  /** The draft-publish arm's own claim, set only for that arm: the head publish pushed, unverified. */
  shippedHead?: string;
  shippedVerified?: false;
}

/**
 * The newest step that was WORK and carried a verdict — an undecided write-ahead is not a verdict, it is the
 * re-verification that never happened. Shared with `handback.ts`, whose cause readers scan the same log.
 */
export function newestDecidedWorkStep(steps: Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined || step.outcome === undefined) continue;
    if (REPORT_STATES.includes(step.state)) continue;
    return step;
  }
  return undefined;
}

/**
 * The newest step of `state` after `after`, verdict or not — a verdictless visit is the one the rule must
 * refuse to ship over. Its decided sibling is `newestDecidedThrough`: a head is taken only from a gate the run
 * recorded and finished. Readers use a step's identity alone.
 */
function newestStateStepAfter(steps: Step[], state: LeanState, after: number): Step | undefined {
  for (let i = steps.length - 1; i > after; i--) {
    const step = steps[i];
    if (step !== undefined && step.state === state) return step;
  }
  return undefined;
}

function newestDecidedThrough(
  steps: Step[],
  state: LeanState,
  throughAt: number,
): Step | undefined {
  for (let i = Math.min(throughAt, steps.length - 1); i >= 0; i--) {
    const step = steps[i];
    if (step !== undefined && step.state === state && step.outcome !== undefined) return step;
  }
  return undefined;
}

/**
 * A green that named no commit is the same standing as no green at all: the run shipped bytes this
 * rule cannot name. The finding is the rule's own, so the comment can say whether the gate spoke
 * at all. Exported for the errored arm, which reads the same head test through this file.
 */
export function noVerifiedHead(head: unknown): HandbackHeads {
  if (typeof head !== "string" || !isFullCommitSha(head))
    return {
      applies: true,
      reason: "the green verify recorded no head, so there is no verified head to ship",
    };
  return { applies: true, verifiedHead: head };
}

/**
 * Does a review step's kind make a handback of this log worth reading at all? `fixed` always does;
 * an `error` does only with #2667's switch on, because a review that threw judged nothing.
 */
function reviewKindHandbackable(step: Step, errored: boolean): boolean {
  if (step.state !== "review" || step.outcome === undefined) return false;
  if (step.outcome.kind === "fixed") return true;
  return errored && erroredReviewHandbackEnabled();
}

/**
 * The head a handback of this log should ship, or the reason it cannot. A log whose newest work step is
 * neither a `fixed` review, an errored review over a certified head, nor a draft publish gets
 * `{applies: false}` with no reason.
 */
export function handbackHeads(steps: Step[]): HandbackHeads {
  const newest = newestDecidedWorkStep(steps);
  if (newest?.outcome === undefined) return { applies: false };
  // The draft-publish arm: `build + exhausted` published this head and no green of this run covers it, so
  // nothing moved. "Covers" is exact — the gate's verdict, the head it recorded, at or before the publish.
  // The head named is the publish step's OWN record, so it prints with origin unreadable.
  if (newest.state === "publish") {
    const head = newest.outcome.publishedHead;
    // The same rule `land.ts` and `ci.ts` apply to a head: a full commit sha, else nothing to name.
    if (typeof head !== "string" || !isFullCommitSha(head)) return { applies: false };
    const green = newestDecidedThrough(steps, "verify", steps.indexOf(newest));
    if (green?.outcome?.kind === "green" && green.outcome.verifiedHead === head)
      return { applies: false };
    return { applies: true, shippedHead: head, shippedVerified: false };
  }
  // #2667, on the switch: a review that THREW over a head the gate certified is read by
  // `../lean-review-incomplete-head.ts`; every other kind outside the pair is silent.
  const errored = isErroredReview(newest);
  if (!reviewKindHandbackable(newest, errored)) return { applies: false };
  const at = steps.indexOf(newest);
  const trailing = newestStateStepAfter(steps, "verify", at);
  if (trailing !== undefined && trailing.outcome === undefined)
    return {
      applies: true,
      reason: `the run entered the gate again at ${trailing.key} and never recorded what it decided, so no head is verified`,
    };
  const green = newestDecidedThrough(steps, "verify", at);
  if (errored) {
    const reading = erroredReviewReading(green);
    if (reading !== undefined) return reading;
  }
  if (green === undefined) return { applies: true, reason: NO_GATE_VERDICT };
  if (green.outcome?.kind !== "green")
    return {
      applies: true,
      reason: `the newest decided verify is ${String(green.outcome?.kind)}, not green, so no head is verified`,
    };
  return noVerifiedHead(green.outcome.verifiedHead);
}
