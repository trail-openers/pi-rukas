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
  NO_GATE_VERDICT,
  type HandbackFindings,
  erroredReviewFindings,
  gateFindings,
} from "../lean-handback-cause.ts";
import { type LeanState, REPORT_STATES, type Step } from "./state.ts";

/**
 * What the operator asks of a head that shipped unverified is why it never got certified. The only place
 * that answer is worded; `handback.ts` quotes the finding rather than re-wording it.
 */
export { NO_GATE_VERDICT } from "../lean-handback-cause.ts";

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
 * The head a handback of this log should ship, or the reason it cannot. A log whose newest work step is
 * neither a `fixed` review, an errored review over a certified head, nor a draft publish gets
 * `{applies: false}` with no reason.
 */
export function handbackHeads(steps: Step[]): HandbackFindings {
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
  const at = steps.indexOf(newest);
  if (newest.state !== "review") return { applies: false };
  // The two review arms, each a call to the reader that words it (#2667): an errored review judged
  // nothing, so over bytes its own gate named it is owed the same report a `fixed` review the gate has
  // not spoken for is owed. The switch that admits an errored review at all is read by that reader.
  if (newest.outcome.kind === "error")
    return erroredReviewFindings(newestDecidedThrough(steps, "verify", at));
  if (newest.outcome.kind !== "fixed") return { applies: false };
  const trailing = newestStateStepAfter(steps, "verify", at);
  return gateFindings(
    newestDecidedThrough(steps, "verify", at),
    trailing?.outcome === undefined ? trailing : undefined,
  );
}
