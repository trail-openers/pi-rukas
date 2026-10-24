/**
 * work-driver-provider-park — how a dispatch failure whose cause is the model
 * ENDPOINT gets named, and what it says about itself (#1243).
 *
 * Split from `work-driver-step-router.ts` (AGENTS.md §12 file-size limit). Pure:
 * reads the dispatch failure the step ended on, writes nothing. The router
 * decides WHEN to park; this module decides what the park is CALLED and what its
 * `evidence` carries, so the two questions do not compete for one file.
 *
 * Why the distinction exists: a cycle that parks because the endpoint was down
 * for forty minutes is not a cycle whose code failed — there is nothing for a
 * person to look at. A headless caller needs to tell the
 * two apart so it can re-queue the first when the endpoint answers again, and
 * the cap is the only thing a headless host switches on.
 */

import { redactClip } from "./decision-log.ts";
import {
  FAILURE_REASON_CHARS,
  classifyFailureCause,
  failureCauseReason,
} from "./work-driver-failure-taxonomy.ts";
import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";

/** The failed-dispatch events a park can be attributed to. */
export type DispatchFailureEvent =
  | Extract<WorkEvent, { kind: "dispatch-failed" }>
  | Extract<WorkEvent, { kind: "dispatch-failed-provider" }>;

/**
 * Did this step die of the ENDPOINT, or of the work?
 *
 * Deliberately narrow. Only a cause the taxonomy read FROM THE PROVIDER counts
 * (`dispatch-failed-provider` / a provider message — the same evidence bar as
 * `isProviderOutage`), and only the causes a minute of waiting can plausibly
 * fix: a transport severance, or a 429 whose stated delay is short enough to
 * wait out. A quota window or a spend cap does NOT qualify — re-queueing an
 * hour later meets the same cap, so those keep `step-failed:<step>` and stay
 * with a person. A self-kill, a loop, or a crashed child is never provider
 * fault, whatever its exit code looks like.
 *
 * The TERMINAL failure is what is classified, and nothing else. With a
 * transient ladder the last attempt is usually the one that fails, so scanning
 * the whole window used to read the same as scanning the tail — but the two
 * come apart on the case that matters: a step that MET an outage early, waited
 * it out, recovered, and then died of a crash. That step died of the crash,
 * and its own evidence says so (`cause=crashed`). Labelling it
 * `provider-unavailable` handed a headless caller a `failure.kind` of
 * `provider` and a resumable handoff — both autonomously re-queueable — for a
 * cycle whose real failure a person has to look at. That is the mislabelling
 * #1243 exists to remove, reproduced in the other direction.
 *
 * The caller passes the `tail` the router already resolved through
 * `failureEventOf` (work-driver-failure-lookup.ts), so the two cannot disagree
 * about which dispatch ended the step — including on a fan-out, where the
 * failure sits behind `branches-converged` rather than at the end of the log.
 */
export function stepParkedOnProvider(tail: DispatchFailureEvent | undefined): boolean {
  // The outage evidence must come from the PROVIDER. `dispatch-failed` is
  // pi-rukas's own record of a child that exited non-zero, was killed, or
  // threw — never a provider stop — so the provider evidence is exactly
  // `kind === "dispatch-failed-provider"` (the `providerMessage` field lives
  // on that member only).
  if (tail?.kind !== "dispatch-failed-provider") return false;
  const cause = classifyFailureCause(tail).cause;
  return cause === "provider-severed" || cause === "rate-limited:burst";
}

/**
 * The cap a dispatch failure parks with: the provider park (#1243) when the
 * endpoint caused it, otherwise the step's own `step-failed:<step>`.
 */
export function dispatchFailCapFor(
  step: WorkStep,
  tail: DispatchFailureEvent | undefined,
): WorkCapLiteral {
  return stepParkedOnProvider(tail) ? "provider-unavailable" : `step-failed:${step}`;
}

/**
 * The provider park's own account of the outage, written on the cap's
 * `evidence`: what the failureCauseReason says the child died of, and what the
 * endpoint itself reported. Both renderers (the handoff body and the headless
 * `failure` block) read this field, so a park caused by an outage says what the
 * outage said instead of falling back to the bare cap name. The failed
 * attempt's cost is already on the `↻ step-retry` line the router emitted before
 * this park, so it is not repeated here.
 *
 * Both park paths (the HALT cap synthesis and the RETRY_ONCE exhaustion) go
 * through `dispatchFailCapHit` below, so the N=1 adversarial park — which
 * reaches handoff through the latter — carries the same account as a develop or
 * explore one.
 */
export function providerParkEvidence(tail: DispatchFailureEvent | undefined): string {
  if (tail === undefined) return "";
  const providerText =
    tail.kind === "dispatch-failed-provider"
      ? (tail.providerMessage ?? "")
      : (tail.errorTail ?? "");
  // The classified cause is named explicitly: a reader (and the handoff test)
  // should not have to infer `provider-severed` from the prose shape.
  const cause = `cause=${classifyFailureCause(tail).cause}`;
  const joined = [failureCauseReason(tail), providerText, cause]
    .filter((part) => part.trim().length > 0)
    .join(" · ");
  // #1243 fix round — the cap's `evidence` is rendered verbatim by BOTH the
  // handoff body and the headless `failure` block, and it is stored in the
  // durable state file. `failureCauseReason` clips its own input to
  // FAILURE_REASON_CHARS but the provider message / error tail concatenated
  // here did not, so a stack-trailing provider body could dominate the handoff
  // and the state file. Same budget as the taxonomy's own, not a second number.
  //
  // Redaction rides through the SAME seam `headless/failure.ts::failureOf` uses
  // (`redactClip`, which redacts then clips): this string is provider-authored
  // text that lands in a durable file and on an operator-facing surface, so it
  // gets the same credential scrub before it is written, not only at render.
  // The bound is the taxonomy's own so the clip stays one number.
  return redactClip(joined, FAILURE_REASON_CHARS);
}

/**
 * A cap-hit parked on a dispatch failure, with the provider park's evidence.
 * The `evidence` field is what makes a provider park legible in the durable
 * state file and the `--json` result, not just in the live scrollback.
 *
 * The `tail` is OPTIONAL (#1243 fix round): a HALT-class fan-out can end on
 * `branches-converged` with failed verdicts and no dispatch-failure event
 * behind it at all (a driver refusal inside the fan-out — `failureEventOf`
 * declines those by design). The caller used to synthesise a bare
 * `dispatch-failed` inline to satisfy a non-optional parameter; an absent tail
 * is the honest answer, it can only ever mean "not a provider park", and the
 * synthesised event was a second shape of the same nothing. The `tail` param
 * already accepts `undefined` everywhere else in this module.
 */
export function dispatchFailCapHit(
  step: WorkStep,
  state: WorkState,
  tail: DispatchFailureEvent | undefined,
): Extract<WorkEvent, { kind: "cap-hit" }> {
  const cap = dispatchFailCapFor(step, tail);
  return {
    kind: "cap-hit",
    at: Date.now(),
    cap,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    ...(cap === "provider-unavailable" ? { evidence: providerParkEvidence(tail) } : {}),
  };
}
