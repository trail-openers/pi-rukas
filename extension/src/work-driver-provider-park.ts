/**
 * work-driver-provider-park — how a dispatch failure whose cause is the model
 * ENDPOINT gets named, and what it says about itself (#1243).
 *
 * Split from `work-driver-step-router.ts` (AGENTS.md §12 file-size limit). Pure:
 * reads the event log a step already left behind, writes nothing. The router
 * decides WHEN to park; this module decides what the park is CALLED and what its
 * `evidence` carries, so the two questions do not compete for one file.
 *
 * Why the distinction exists: a cycle that parks because the endpoint was down
 * for forty minutes is not a cycle whose code failed — there is nothing for a
 * person to look at. The caller (orchard runs pi-rukas headless) needs to tell the
 * two apart so it can re-queue the first when the endpoint answers again, and
 * the cap is the only thing a headless host switches on.
 */

import { classifyFailureCause, failureCauseReason } from "./work-driver-failure-taxonomy.ts";
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
 * "Any failed dispatch in the step" rather than only the last one: with a
 * transient ladder the last attempt is usually the one that fails, but a step
 * that met the outage and then died of something else is not a provider park.
 */
export function stepParkedOnProvider(eventLog: readonly WorkEvent[]): boolean {
  let sawProvider = false;
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const e = eventLog[i];
    if (!e) continue;
    if (e.kind === "step-started") break;
    if (e.kind !== "dispatch-failed" && e.kind !== "dispatch-failed-provider") continue;
    // The outage evidence must come from the PROVIDER. `dispatch-failed` is
    // pi-rukas's own record of a child that exited non-zero, was killed, or
    // threw — never a provider stop — so the provider evidence is exactly
    // `kind === "dispatch-failed-provider"` (the `providerMessage` field lives
    // on that member only).
    if (e.kind !== "dispatch-failed-provider") continue;
    const cause = classifyFailureCause(e).cause;
    if (cause === "provider-severed" || cause === "rate-limited:burst") sawProvider = true;
  }
  return sawProvider;
}

/**
 * The cap a dispatch failure parks with: the provider park (#1243) when the
 * endpoint caused it, otherwise the step's own `step-failed:<step>`.
 */
export function dispatchFailCapFor(step: WorkStep, eventLog: readonly WorkEvent[]): WorkCapLiteral {
  return stepParkedOnProvider(eventLog) ? "provider-unavailable" : `step-failed:${step}`;
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
export function providerParkEvidence(tail: DispatchFailureEvent): string {
  const providerText =
    tail.kind === "dispatch-failed-provider"
      ? (tail.providerMessage ?? "")
      : (tail.errorTail ?? "");
  // The classified cause is named explicitly: a reader (and the handoff test)
  // should not have to infer `provider-severed` from the prose shape.
  const cause = `cause=${classifyFailureCause(tail).cause}`;
  return [failureCauseReason(tail), providerText, cause]
    .filter((part) => part.trim().length > 0)
    .join(" · ");
}

/**
 * A cap-hit parked on a dispatch failure, with the provider park's evidence.
 * The `evidence` field is what makes a provider park legible in the durable
 * state file and the `--json` result, not just in the live scrollback.
 */
export function dispatchFailCapHit(
  step: WorkStep,
  state: WorkState,
  tail: DispatchFailureEvent,
): Extract<WorkEvent, { kind: "cap-hit" }> {
  const cap = dispatchFailCapFor(step, state.eventLog);
  return {
    kind: "cap-hit",
    at: Date.now(),
    cap,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    ...(cap === "provider-unavailable" ? { evidence: providerParkEvidence(tail) } : {}),
  };
}
