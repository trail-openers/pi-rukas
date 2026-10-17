/**
 * work-driver-step-router-tail — the tail of `routeStepOutcome`: the PR7
 * multi-workstream halt-cascade router and the #1016 driver-refusal router.
 *
 * Split out of `work-driver-step-router.ts` for the 500-line gate (AGENTS.md
 * §12). Neither is touched by #1391 — they are the two blocks that fire after
 * the single-dispatch router has had its say, and both are unchanged by the
 * retry-tree work; only their file moved.
 */

import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { STEP_FAILURE_POLICY } from "./work-driver-failure-policy.ts";
import { refusedWorkstreams } from "./work-driver-step-refusal.ts";
import { type WorkState, type WorkStep, appendEvent, persistCycle } from "./workflow-state.ts";

/**
 * The two tail routers, in their original order. Returns the router's
 * `{ state, retry }` when one of them halts the step, or undefined when neither
 * did and `routeStepOutcome` should fall through to the `nextStep()` transition.
 */
export async function routeTailRouters(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
): Promise<{ state: WorkState; retry: boolean } | undefined> {
  // PR7 — multi-workstream halt-cascade router. PR3 emits
  // `branches-converged` for N>1 fanouts (develop, lens-review).
  // The PR5 dispatch-failed router above only watches single-dispatch
  // tails, so all-branches-failed silently advanced into wasted
  // adversarial + lens-review (the /work 553 2026-06-24 re-test:
  // 3-of-3 develop branches provider-errored mid-stream, driver
  // advanced into adversarial APPROVAL of empty diff and lens-review
  // against header-only "diff").
  //
  // Doctrine: ANY failed branch on a HALT-class step routes to
  // handoff. Partial success on multi-workstream is not a meaningful
  // input downstream — the out-of-scope fence doctrine implies a failed
  // branch leaves the broader decomposition incoherent.
  {
    const tail = state.eventLog[state.eventLog.length - 1];
    if (tail?.kind === "branches-converged" && tail.verdicts.length > 0) {
      const anyFailed = tail.verdicts.some((v) => !v.ok);
      const policy = STEP_FAILURE_POLICY[step];
      if (anyFailed && policy === "HALT") {
        let next = appendEvent(state, {
          kind: "cap-hit",
          at: Date.now(),
          cap: `step-failed:${step}` as const,
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff",
        });
        next = {
          ...next,
          pipelineState: { ...next.pipelineState, currentStep: "handoff" },
        };
        await persistCycle(ctx, next);
        const failedCount = tail.verdicts.filter((v) => !v.ok).length;
        trace(
          `work-driver: HALT on step="${step}" — ${failedCount}/${tail.verdicts.length} branches failed → handoff`,
        );
        return { state: next, retry: true };
      }
      // RETRY_ONCE doesn't apply to multi-workstream fanouts (no step
      // in STEP_FAILURE_POLICY that fans out is RETRY_ONCE — develop
      // is HALT, lens-review N>1 path uses the same N>1 fanout but
      // its retry semantics are handled internally by runLensReview).
      // DEGRADED_OK: fall-through.
    }
  }

  // #1016 — a driver REFUSAL halts the step as a non-transient failure. N=1
  // has no branches-converged, so the fan-out check above cannot see it; the
  // refusal is never retried with backoff and never advances the cycle.
  {
    const refusals = refusedWorkstreams(state.eventLog, step);
    const parked = state.eventLog[state.eventLog.length - 1]?.kind === "cap-hit";
    if (refusals.length > 0 && !parked && STEP_FAILURE_POLICY[step] === "HALT") {
      let next = appendEvent(state, {
        kind: "cap-hit",
        at: Date.now(),
        cap: `step-failed:${step}` as const,
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      });
      next = { ...next, pipelineState: { ...state.pipelineState, currentStep: "handoff" } };
      await persistCycle(ctx, next);
      trace(
        `work-driver: HALT on step="${step}" — refused: ${refusals.map((r) => `${r.id} (${r.reason})`).join("; ")} → handoff`,
      );
      return { state: next, retry: true };
    }
  }

  return undefined;
}
