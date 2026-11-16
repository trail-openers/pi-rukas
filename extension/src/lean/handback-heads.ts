/**
 * lean/handback-heads — the one reading of the step log that says whether a handback is
 * standing over unverified bytes, and which head it should ship.
 *
 * The rule keys on the LOG, not on the stop cause. A `review` step whose fix wave pushed is
 * the only edge in the table that puts unverified bytes on origin's branch while the run is
 * still walking: `machine.ts` routes `fixed` back through `verify`, so a run that reached
 * `handback` with a `fixed` review as its newest WORK step and no decided `verify` behind it
 * never ran that re-verification. How it got there changes nothing about what origin holds.
 *
 * The undecided entry a crash left behind is not work the run did: it is the re-verification
 * that never happened, so the newest work step is the last step of a state the run was told
 * something by.
 *
 * "We know a head we can ship" is a different claim from "the run once saw a gate", so the
 * newest DECIDED `verify` must be `green` and must name a head.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { type LeanState, REPORT_STATES, type Step } from "./state.ts";

/** What the handback ships: the green's head, or nothing. */
export interface HandbackHeads {
  /**
   * True when the newest WORK step is a `fixed` review that the gate has not spoken
   * for since — and a gate visit the run ENTERED and never answered counts as not
   * speaking, not as silence to step over.
   */
  applies: boolean;
  /**
   * The newest decided green `verify`'s head — the newest green at or before the
   * review, which is where the run's gate last spoke for the head the review then
   * moved — or `undefined` when the log has none.
   */
  verifiedHead?: string;
  /** Why nothing is shipped, in the record's own words, when there is no head to ship. */
  reason?: string;
}

/**
 * The newest step that was WORK and carried a verdict, and WHERE it sits.
 *
 * The position is part of the answer: the rule has to say whether the gate was decided before
 * or after this step, and the only thing that orders two steps is their place in the log.
 */
function newestDecidedWorkStep(steps: Step[]): { step: Step; at: number } | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined || step.outcome === undefined) continue;
    if (REPORT_STATES.includes(step.state)) continue;
    return { step, at: i };
  }
  return undefined;
}

/**
 * The newest step of `state` sitting after `after`, whether or not it carried a verdict,
 * and WHERE it sits.
 *
 * The undecided shape is the answer the caller wants: the rule needs every gate visit the
 * review closed, and a visit with no verdict is the one it must refuse to ship over.
 */
function newestStateStepAfter(
  steps: Step[],
  state: LeanState,
  after: number,
): { step: Step; at: number } | undefined {
  for (let i = steps.length - 1; i > after; i--) {
    const step = steps[i];
    if (step === undefined || step.state !== state) continue;
    return { step, at: i };
  }
  return undefined;
}

/**
 * The newest decided step of one state at or before `throughAt`.
 *
 * The other half of the same reading: the green the rule may take a head from is one the run
 * recorded and finished, in the part of the log the review closes off.
 */
function newestDecidedThrough(
  steps: Step[],
  state: LeanState,
  throughAt: number,
): { step: Step; at: number } | undefined {
  for (let i = Math.min(throughAt, steps.length - 1); i >= 0; i--) {
    const step = steps[i];
    if (step === undefined || step.state !== state || step.outcome === undefined) continue;
    return { step, at: i };
  }
  return undefined;
}

/**
 * The head a handback of this log should ship, or the reason it cannot ship one.
 *
 * A log whose newest work step is anything but a `fixed` review gets `{applies: false}` with
 * no reason: that run left origin where its own step left it.
 */
export function handbackHeads(steps: Step[]): HandbackHeads {
  const newestWork = newestDecidedWorkStep(steps);
  if (newestWork === undefined) return { applies: false };
  const newest = newestWork.step;
  if (newest?.state !== "review" || newest.outcome?.kind !== "fixed") return { applies: false };
  // Anything the gate stepped into AFTER the review has to be looked at, verdict or no
  // verdict, before any older green may speak for the head.
  const trailing = newestStateStepAfter(steps, "verify", newestWork.at);
  if (trailing !== undefined && trailing.step.outcome === undefined)
    return {
      applies: true,
      reason: `the run entered the gate again at ${trailing.step.key} and never recorded what it decided, so no head is verified`,
    };
  const green = newestDecidedThrough(steps, "verify", newestWork.at);
  if (green === undefined)
    return {
      applies: true,
      reason: "no verify step of this run decided anything, so no head is verified",
    };
  // This is the arm that says the walk then SHIPS the green it stopped at — an inverted
  // comparison here shows up only as a record that shipped nothing when it should have shipped
  // the certified head.
  if (green.step.outcome?.kind !== "green")
    return {
      applies: true,
      reason: `the newest decided verify is ${String(green.step.outcome?.kind)}, not green, so no head is verified`,
    };
  const head = green.step.outcome.verifiedHead;
  // The same rule `land.ts` and `ci.ts` apply to this field: a head is a full commit sha, and
  // anything else is the green having named no head at all. The answer the operator needs here
  // is the rule's own, not git's complaint about a refspec.
  if (typeof head !== "string" || !isFullCommitSha(head))
    return {
      applies: true,
      reason: "the green verify recorded no head, so there is no verified head to ship",
    };
  return { applies: true, verifiedHead: head };
}
