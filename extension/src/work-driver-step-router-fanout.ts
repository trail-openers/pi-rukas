/**
 * work-driver-step-router-fanout — the PR7 multi-workstream halt-cascade
 * router, extracted from work-driver-step-router.ts (AGENTS.md §12 size limit).
 *
 * PR3 emits `branches-converged` for N>1 fan-outs (develop, lens-review). The
 * single-dispatch router in the step router only watches dispatch tails, so an
 * all-branches-failed fan-out used to advance into wasted adversarial +
 * lens-review (the /work 553 2026-06-24 re-test: 3-of-3 develop branches
 * provider-errored mid-stream, the driver advanced into adversarial APPROVAL of
 * an empty diff and lens-review against a header-only "diff").
 *
 * Doctrine: ANY failed branch on a HALT-class step routes to handoff. Partial
 * success on a multi-workstream step is not a meaningful input downstream — the
 * out-of-scope fence doctrine implies a failed branch leaves the broader
 * decomposition incoherent.
 *
 * #1243 — the cap the park carries is `dispatchFailCapHit`'s, the same reading
 * every other dispatch failure in this pipeline gets: `failureEventOf` resolves
 * the dispatch BEHIND the `branches-converged` (and declines when any
 * workstream succeeded, so a partial fan-out has no single terminal failure and
 * keeps the plain step cap). Without it, a fan-out that EVERY child lost to a
 * severed stream — the one shape unambiguously the endpoint's — parked
 * `step-failed:<step>` with `failure.kind: "process"`, the one cap a headless
 * caller cannot re-queue on. A driver REFUSAL carries no dispatch failure event
 * at all, so it resolves to nothing and stays `step-failed:<step>`: refusals are
 * never provider parks.
 */

import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { failureEventOf } from "./work-driver-failure-lookup.ts";
import { STEP_FAILURE_POLICY } from "./work-driver-failure-policy.ts";
import { dispatchFailCapHit } from "./work-driver-provider-park.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";
import { appendEvent, persistCycle } from "./workflow-state.ts";

export interface FanoutOutcome {
  state: WorkState;
  /** The caller re-runs the same step on its next loop iteration. */
  retry: boolean;
}

/**
 * Route a `branches-converged` tail. Returns `undefined` when this router has
 * nothing to say — the tail is not a converged fan-out, no branch failed, or
 * the step is not HALT-class — so the caller falls through unchanged.
 */
export async function routeFanoutHalt(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
): Promise<FanoutOutcome | undefined> {
  const tail = state.eventLog[state.eventLog.length - 1];
  if (tail?.kind !== "branches-converged" || tail.verdicts.length === 0) return undefined;
  const anyFailed = tail.verdicts.some((v) => !v.ok);
  const policy = STEP_FAILURE_POLICY[step];
  if (!anyFailed || policy !== "HALT") return undefined;

  // RETRY_ONCE does not apply to multi-workstream fan-outs (no step in
  // STEP_FAILURE_POLICY that fans out is RETRY_ONCE — develop is HALT, and the
  // lens-review N>1 path's retry semantics are handled internally by
  // runLensReview). So a failed HALT-class fan-out halts directly.
  //
  // #1243 fix round — `failureEventOf`'s answer is passed straight through,
  // narrowed to the dispatch-failure union, including `undefined`: a fan-out
  // whose failure was a driver REFUSAL has no dispatch-failure event at all
  // (`failureEventOf` declines those by design), and the cap builder reads an
  // absent tail as "not a provider park", which is the truth. The caller used
  // to synthesise a bare `dispatch-failed` event to satisfy a non-optional
  // parameter — a second shape of the same nothing.
  const failedDispatch = failureEventOf(state.eventLog);
  const capEvent = dispatchFailCapHit(
    step,
    state,
    failedDispatch?.kind === "dispatch-failed" ||
      failedDispatch?.kind === "dispatch-failed-provider"
      ? failedDispatch
      : undefined,
  );
  let next = appendEvent(state, capEvent);
  next = { ...next, pipelineState: { ...next.pipelineState, currentStep: "handoff" } };
  await persistCycle(ctx, next);
  const failedCount = tail.verdicts.filter((v) => !v.ok).length;
  trace(
    `work-driver: HALT on step="${step}" — ${failedCount}/${tail.verdicts.length} branches failed → cap="${capEvent.cap}" → handoff`,
  );
  return { state: next, retry: true };
}
