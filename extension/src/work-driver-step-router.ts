/**
 * work-driver-step-router — post-step outcome routing for runWorkDriver's
 * main loop.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Called
 * once per loop iteration immediately after `runStep` returns (without
 * throwing): emits the scrollback lifecycle line for the step's outcome,
 * then applies the PR5 single-dispatch halt-cascade router and the PR7
 * multi-workstream halt-cascade router. Returns the (possibly mutated)
 * state plus whether the caller should `continue` the loop immediately
 * (retry / re-entered-via-handoff) rather than fall through to the
 * `nextStep()` transition.
 */

import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import { STEP_FAILURE_POLICY } from "./work-driver-context.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  classifyFailureCause,
  failureCauseReason,
  failureCauseReasonForClass,
  jitteredMs,
  transientRetryBackoffMs,
  transientRetryEnabled,
} from "./work-driver-failure-taxonomy.ts";
import { type WorkState, type WorkStep, appendEvent, writeState } from "./workflow-state.ts";

/**
 * #366 — injectable sleep. Real waits are the point in production (a burst
 * 429 clears by waiting), but the offline suite must never actually sleep, so
 * the seam is here rather than a bare setTimeout at each call site.
 */
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** Test seam. Returns a restore function. */
export function __setSleepFn(fn: (ms: number) => Promise<void>): () => void {
  const prev = sleepFn;
  sleepFn = fn;
  return () => {
    sleepFn = prev;
  };
}

/**
 * Step completed — figure out if it ended in a step-failure-shaped
 * event so the lifecycle line marks failure even though runStep
 * didn't throw. Most-recent event drives the decision. Then apply the
 * PR5 / PR7 halt-cascade routers. Returns `retry: true` when the caller
 * should `continue` its while-loop without reaching the `nextStep()`
 * transition (a retry re-run or a synthesized cap-hit → handoff
 * re-entry, both of which already persisted state via `writeState`).
 */
export async function routeStepOutcome(
  ctx: DriverContext,
  stateIn: WorkState,
  step: WorkStep,
  stepOrd: { num: number; total: number },
  stepRound: number,
  stepStartedAt: number,
): Promise<{ state: WorkState; retry: boolean }> {
  let state = stateIn;
  {
    const lastEvent = state.eventLog[state.eventLog.length - 1];
    const elapsed = Date.now() - stepStartedAt;
    if (lastEvent?.kind === "dispatch-failed" || lastEvent?.kind === "dispatch-failed-provider") {
      // #314 — classify once, derive both reason and retry policy.
      const classification = classifyFailureCause(lastEvent);
      const reason = failureCauseReasonForClass(lastEvent, classification);
      // #299 — when the halt-cascade router below is about to RETRY this
      // failure, skip the ✗ step-failed line: the single ↻ retry line
      // carries the reason, and pre-#299 one transient produced multiple
      // provider-blame lines with no retraction on recovery.
      const policy = STEP_FAILURE_POLICY[step];
      const semanticRetryAvailable =
        policy === "RETRY_ONCE" && (state.pipelineState.retryAttempts?.[step] ?? 0) < 1;
      const transientRetryAvailable =
        policy === "HALT" &&
        transientRetryEnabled() &&
        classification.shouldRetry &&
        (state.pipelineState.transientRetryAttempts?.[step] ?? 0) < classification.maxRetries;
      if (!semanticRetryAvailable && !transientRetryAvailable) {
        lifecycle.emitStepFailed(
          step,
          stepOrd.num,
          stepOrd.total,
          elapsed,
          reason,
          stepRound,
          ctx.issue,
        );
      }
    } else if (lastEvent?.kind === "cap-hit") {
      lifecycle.emitStepFailed(
        step,
        stepOrd.num,
        stepOrd.total,
        elapsed,
        `cap-hit: ${lastEvent.cap}`,
        stepRound,
        ctx.issue,
      );
    } else {
      // Sum tokens from any dispatch-completed events that fired during
      // this step. Approximate but useful — exact accounting per step
      // would require time-window filtering of usage events.
      let totalTokens: number | undefined;
      if (lastEvent?.kind === "dispatch-completed" && lastEvent.summary !== undefined) {
        // Driver-owned dispatches don't surface usage on the completion
        // event; leave undefined and let the per-dispatch line carry it.
        totalTokens = undefined;
      }
      // #297/#299 — successful completion resets BOTH retry budgets
      // (per-attempt semantics: a later step-back re-entry gets a fresh
      // budget) and marks the scrollback line "recovered after retry"
      // when a ↻ line preceded it.
      const usedSemantic = state.pipelineState.retryAttempts?.[step] ?? 0;
      const usedTransient = state.pipelineState.transientRetryAttempts?.[step] ?? 0;
      const recovered = usedSemantic > 0 || usedTransient > 0;
      if (recovered) {
        const { [step]: _semantic, ...restRetry } = state.pipelineState.retryAttempts ?? {};
        const { [step]: _transient, ...restTransient } =
          state.pipelineState.transientRetryAttempts ?? {};
        state = {
          ...state,
          pipelineState: {
            ...state.pipelineState,
            retryAttempts: restRetry,
            transientRetryAttempts: restTransient,
          },
        };
      }
      lifecycle.emitStepCompleted(
        step,
        stepOrd.num,
        stepOrd.total,
        elapsed,
        totalTokens,
        stepRound,
        recovered,
        ctx.issue,
      );
    }
  }
  await writeState(ctx.repoRoot, state);

  // PR5 halt-cascade router. Intercept dispatch-failed at HALT-class
  // steps BEFORE nextStep() — the existing linear table has no
  // dispatch-failed branch and would silently advance the cycle into
  // wasted downstream work (the #553 cascade root).
  {
    const tail = state.eventLog[state.eventLog.length - 1];
    const isDispatchFail =
      tail?.kind === "dispatch-failed" || tail?.kind === "dispatch-failed-provider";
    if (isDispatchFail) {
      const policy = STEP_FAILURE_POLICY[step];
      // #308 — transient failures on HALT-class steps get a bounded
      // retry with backoff BEFORE the halt-cascade. The work was
      // interrupted (provider blip, #296 kill), not judged; aborting a
      // multi-hour cycle over one transient was the reliability
      // regression's amplifier. Semantic failures fall through to HALT
      // unchanged. (When REPLAY_ONCE (#276) lands for develop, its
      // evidence-carrying replay fires from its own router branch and
      // this generic path becomes develop's fallback.)
      const classification = classifyFailureCause(tail);
      if (policy === "HALT" && transientRetryEnabled() && classification.shouldRetry) {
        const attempts = state.pipelineState.transientRetryAttempts ?? {};
        const used = attempts[step] ?? 0;
        if (used < classification.maxRetries) {
          state = {
            ...state,
            pipelineState: {
              ...state.pipelineState,
              transientRetryAttempts: { ...attempts, [step]: used + 1 },
            },
          };
          await writeState(ctx.repoRoot, state);
          const reason = failureCauseReason(tail);
          lifecycle.emitStepRetry(step, stepOrd.num, stepOrd.total, used + 2, reason, ctx.issue);
          trace(
            `work-driver: retry on step="${step}" (attempt ${used + 2}/${classification.maxRetries + 1}, cause=${classification.cause})`,
          );
          // #366 — honour the provider's own requested delay when it stated
          // one (a rate-limit floor: waiting less is what earns the next 429),
          // otherwise the linear transient backoff. Full jitter either way, so
          // parallel cycles that trip the same limit don't resynchronise into
          // a thundering herd (#289 makes that concrete).
          const base = transientRetryBackoffMs() * (used + 1);
          const backoff = jitteredMs(base, classification.waitMs ?? 0);
          if (backoff > 0) await sleepFn(backoff);
          return { state, retry: true }; // re-run same step on next loop iteration
        }
        // Budget exhausted → fall through to the HALT cap-hit below.
      }
      if (policy === "HALT") {
        // #308 — use structured killCause for cap detection instead of
        // regex-matching errorTail. A timeout self-kill is a deliberate
        // budget cap; it should NEVER be retried.
        const isTimeout = (tail as { killCause?: string }).killCause === "timeout";
        const cap =
          step === "develop" && isTimeout
            ? ("developer-timeout" as const)
            : (`step-failed:${step}` as const);
        state = appendEvent(state, {
          kind: "cap-hit",
          at: Date.now(),
          cap,
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff",
        });
        // Set currentStep='handoff' but LEAVE status='running' so the
        // loop re-enters and runs runHandoff. runHandoff's final block
        // sets status based on the cap shape (mid-flight failure →
        // 'aborted', cap-hit verdict → 'handoff').
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, currentStep: "handoff" },
        };
        await writeState(ctx.repoRoot, state);
        trace(
          `work-driver: HALT on step="${step}" → cap="${cap}" → handoff (status set in runHandoff)`,
        );
        return { state, retry: true };
      }
      if (policy === "RETRY_ONCE") {
        // #366 — an infrastructure fault must never decrement the SEMANTIC
        // attempt budget. Pre-fix this branch never consulted the
        // classification, so one 429 on `adversarial` burned the single
        // semantic retry and the next failure — of any kind — halted the
        // cycle. Infra faults on RETRY_ONCE steps use the transient budget,
        // same as HALT-class steps do.
        const infra = classification.cause !== "crashed-unknown" && classification.shouldRetry;
        const attempts = infra
          ? (state.pipelineState.transientRetryAttempts ?? {})
          : (state.pipelineState.retryAttempts ?? {});
        const used = attempts[step] ?? 0;
        const budget = infra ? classification.maxRetries : 1;
        if (used < budget) {
          const bumped = { ...attempts, [step]: used + 1 };
          state = {
            ...state,
            pipelineState: {
              ...state.pipelineState,
              ...(infra ? { transientRetryAttempts: bumped } : { retryAttempts: bumped }),
            },
          };
          await writeState(ctx.repoRoot, state);
          const reason = failureCauseReason(tail);
          lifecycle.emitStepRetry(step, stepOrd.num, stepOrd.total, used + 2, reason, ctx.issue);
          trace(
            `work-driver: RETRY_ONCE on step="${step}" (attempt ${used + 2}, budget=${infra ? "transient" : "semantic"})`,
          );
          if (infra) {
            const wait = jitteredMs(
              transientRetryBackoffMs() * (used + 1),
              classification.waitMs ?? 0,
            );
            if (wait > 0) await sleepFn(wait);
          }
          return { state, retry: true }; // re-run same step on next loop iteration
        }
        // Retry exhausted → HALT via the same cap shape. Same
        // pattern as the HALT branch above — leave status='running'
        // so the loop runs runHandoff next; runHandoff sets the
        // terminal status based on the cap shape.
        state = appendEvent(state, {
          kind: "cap-hit",
          at: Date.now(),
          cap: `step-failed:${step}` as const,
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff",
        });
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, currentStep: "handoff" },
        };
        await writeState(ctx.repoRoot, state);
        trace(
          `work-driver: RETRY_ONCE exhausted on step="${step}" → handoff (status set in runHandoff)`,
        );
        return { state, retry: true };
      }
      // DEGRADED_OK: existing fall-through is correct (no-op here).
    }
  }

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
        state = appendEvent(state, {
          kind: "cap-hit",
          at: Date.now(),
          cap: `step-failed:${step}` as const,
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff",
        });
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, currentStep: "handoff" },
        };
        await writeState(ctx.repoRoot, state);
        const failedCount = tail.verdicts.filter((v) => !v.ok).length;
        trace(
          `work-driver: HALT on step="${step}" — ${failedCount}/${tail.verdicts.length} branches failed → handoff`,
        );
        return { state, retry: true };
      }
      // RETRY_ONCE doesn't apply to multi-workstream fanouts (no step
      // in STEP_FAILURE_POLICY that fans out is RETRY_ONCE — develop
      // is HALT, lens-review N>1 path uses the same N>1 fanout but
      // its retry semantics are handled internally by runLensReview).
      // DEGRADED_OK: fall-through.
    }
  }

  return { state, retry: false };
}
