/**
 * work-driver-step-router — post-step outcome routing for runWorkDriver's main loop.
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

import { abortableSleep } from "./dispatch-retry.ts";
import * as lifecycle from "./lifecycle-events.ts";
import type { RoleName } from "./roles.ts";
import { drainSlowEvents, foldSlowEvents } from "./slow-events.ts";
import { trace } from "./trace.ts";
import { capKilledString } from "./work-driver-cap-killed.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { dispatchTokens } from "./work-driver-cycle-total.ts";
import { failureEventOf } from "./work-driver-failure-lookup.ts";
import { STEP_FAILURE_POLICY } from "./work-driver-failure-policy.ts";
import {
  classifyFailureCause,
  failureCauseReason,
  failureCauseReasonForClass,
  jitteredMs,
  providerRetryWaitMs,
  shadowFailureCause,
  stepRetryBudget,
  transientRetryBackoffMs,
  transientRetryEnabled,
} from "./work-driver-failure-taxonomy.ts";
import {
  type DispatchFailureEvent,
  dispatchFailCapHit,
  providerParkEvidence,
  stepParkedOnProvider,
} from "./work-driver-provider-park.ts";
import { lostAttemptLine } from "./work-driver-retry-context.ts";
import { refusedWorkstreams } from "./work-driver-step-refusal.ts";
import { routeFanoutHalt } from "./work-driver-step-router-fanout.ts";
import type { CapEvidence } from "./workflow-state-cap.ts";
import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import { type WorkState, type WorkStep, appendEvent, persistCycle } from "./workflow-state.ts";

/**
 * #366 — injectable sleep. Real waits are the point in production (a burst
 * 429 clears by waiting), but the offline suite must never actually sleep, so
 * the seam is here rather than a bare setTimeout at each call site.
 *
 * #1243 fix round — the seam takes the cycle's `AbortSignal`, threaded from
 * `ctx.signal` at both provider-wait sites. The provider ladder waits minutes,
 * and a wait a SIGTERM cannot interrupt is a shutdown that waits out the ladder
 * before it answers. The default resolves early on abort and `unref()`s its
 * timer so a parked wait never holds the process open.
 */
let sleepFn: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep;

/**
 * The provider-ladder wait: injected in tests, abort-aware in production.
 * #1243 — exported for the adversarial fan-out's in-step retry, which must go
 * through THIS seam (not its own `abortableSleep`) so one test seam observes
 * every provider wait the driver takes and the abort signal is threaded the
 * same way at both sites.
 */
export async function providerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await sleepFn(ms, signal);
}

/** Test seam. Returns a restore function. */
export function __setSleepFn(fn: (ms: number, signal?: AbortSignal) => Promise<void>): () => void {
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
 * re-entry, both of which already persisted state via `persistCycle`).
 */
/**
 * The dispatch failure this step ended on lives in
 * `work-driver-failure-lookup.ts` (AGENTS.md §12 size limit).
 */

export async function routeStepOutcome(
  ctx: CycleContext,
  stateIn: WorkState,
  step: WorkStep,
  stepOrd: { num: number; total: number },
  stepRound: number,
  stepStartedAt: number,
): Promise<{ state: WorkState; retry: boolean }> {
  // #799 — drain THIS cycle's slow-event buffer into its state BEFORE the
  // persistence below (this is the driver's single step-boundary persistence
  // point, and the `dispatch-slow` events the per-step `onSlow` recorders
  // collect land here, exactly once, regardless of which step recorded
  // them). The buffer is keyed by the cycle's primary issue (the registry's
  // cycle identity), so a sibling cycle running concurrently in this process
  // drains only its own list. They are folded in BEHIND the step's own
  // events (foldSlowEvents): the tail is what nextStep() routes on.
  const slowEvents = drainSlowEvents(ctx.issue);
  // #1016 — the driver's own refusals for this step (see work-driver-step-refusal.ts).
  const refusals = refusedWorkstreams(stateIn.eventLog, step);
  let state =
    slowEvents.length > 0
      ? { ...stateIn, eventLog: foldSlowEvents(stateIn.eventLog, slowEvents, step) }
      : stateIn;
  {
    const lastEvent = failureEventOf(state.eventLog);
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
        policy === "RETRY_ONCE" &&
        (state.pipelineState.retryAttempts?.[step] ?? 0) < stepRetryBudget(classification, false);
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
    } else if (refusals.length > 0) {
      lifecycle.emitStepFailed(
        step,
        stepOrd.num,
        stepOrd.total,
        elapsed,
        `refused: ${refusals.map((r) => r.id).join(", ")}`,
        stepRound,
        ctx.issue,
      );
    } else {
      // Sum tokens from any dispatch-completed events that fired during
      // this step. Approximate but useful — exact accounting per step
      // would require time-window filtering of usage events. #534 — now
      // backed by the usage field on the completion events themselves
      // (raw sum, retries as separate rows, matching the cycle total);
      // undefined when the event carried no usage (older state files),
      // which the scrollback line omits rather than rendering as 0.
      let totalTokens: number | undefined;
      if (lastEvent?.kind === "dispatch-completed") {
        const t = dispatchTokens(lastEvent);
        if (t > 0) totalTokens = t;
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
  await persistCycle(ctx, state);

  // PR5 halt-cascade router. Intercept dispatch-failed at HALT-class
  // steps BEFORE nextStep() — the existing linear table has no
  // dispatch-failed branch and would silently advance the cycle into
  // wasted downstream work (the #553 cascade root).
  {
    // The SAME lookup the scrollback block above used. Reading the raw tail
    // here left a fan-out's transient failure unretried while the block above
    // had already withheld its ✗ line for the retry: `failureEventOf` was
    // feeding the message and not the decision.
    const tail = failureEventOf(state.eventLog);
    // A fan-out's failure sits behind `branches-converged`. Only the transient
    // retry applies to it; its halt belongs to the fan-out router below, and
    // RETRY_ONCE fan-outs (adversarial) keep their own per-workstream budget.
    const buried = tail !== state.eventLog[state.eventLog.length - 1];
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
      // #1308 S3 — acted on here, so the failure-cause seam is asked (in shadow).
      shadowFailureCause(tail, classification, {
        repoRoot: ctx.repoRoot,
        issues: ctx.issues ?? [ctx.issue],
      });
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
          await persistCycle(ctx, state);
          // The retry is a fresh child: say what the failed one took with it.
          const lost = lostAttemptLine(step, used + 1, tail);
          const reason = `${failureCauseReason(tail)} · ${lost}`;
          lifecycle.emitStepRetry(step, stepOrd.num, stepOrd.total, used + 2, reason, ctx.issue);
          trace(
            `work-driver: retry on step="${step}" (attempt ${used + 2}/${classification.maxRetries + 1}, cause=${classification.cause}) — ${lost}`,
          );
          // #366 — honour the provider's own requested delay when it stated
          // one (a rate-limit floor: waiting less is what earns the next 429),
          // otherwise the linear transient backoff. Full jitter either way, so
          // parallel cycles that trip the same limit don't resynchronise into
          // a thundering herd (#289 makes that concrete).
          // #1243 — a provider-class failure waits at least
          // providerRetryFloorMs() × attempt (bounded by the total), not the
          // 5s/10s ladder: every sub-minute wait lands inside the same outage.
          const base = providerRetryWaitMs(
            classification,
            used + 1,
            transientRetryBackoffMs() * (used + 1),
          );
          const backoff = jitteredMs(base, classification.waitMs ?? 0);
          // #1243 fix round — abort-aware: a SIGTERM during a minutes-long
          // provider wait ends the wait, it does not sit it out.
          if (backoff > 0) await providerSleep(backoff, ctx.signal);
          return { state, retry: true }; // re-run same step on next loop iteration
        }
        // Budget exhausted → fall through to the HALT cap-hit below.
      }
      if (policy === "HALT" && !buried) {
        // #308 — use structured killCause for cap detection instead of
        // regex-matching errorTail. A timeout self-kill is a deliberate
        // budget cap; it should NEVER be retried.
        const killCause = (tail as { killCause?: string }).killCause;
        // #543 — a loop / token-budget self-kill parks with the fixed-literal
        // cap (`loop-detected` / `token-budget`) INSTEAD of `step-failed:<step>`.
        // It is not a provider fault and must never be retried (the HALT branch
        // already refuses retry: `shouldRetry` is false, so the #308 retry block
        // above never ran). The fixed literal (no `'<role>'` suffix) + the
        // `role` field is what F4(f) requires; explainCap reads capEvidence for
        // the trigger detail.
        const capKilled = tail.kind === "dispatch-failed" ? capKilledString(tail) : undefined;
        // #1243 fix round — the SAME tail `failureEventOf` resolved above, not a
        // scan of the step window: a step that met an outage early and then died
        // of a crash ends on the crash, and parks as one.
        const providerCap = capKilled === undefined && stepParkedOnProvider(tail);
        const cap =
          capKilled ??
          (step === "develop" && killCause === "timeout"
            ? ("developer-timeout" as const)
            : step === "plan" && killCause === "plan-timeout"
              ? // #754 — mirrors the develop `developer-timeout` special case:
                //   the plan step's own bound expired and its one-shot
                //   corrective re-dispatch did not recover, so the operator
                //   sees a cap that names the plan step, not a generic one.
                ("plan-timeout" as const)
              : // #1243 — a park the ENDPOINT caused gets its own cap, so a
                //   headless caller can re-queue it when the provider answers
                //   again instead of treating it as a real failure.
                providerCap
                ? ("provider-unavailable" as const)
                : (`step-failed:${step}` as WorkCapLiteral));
        const capEvent: Extract<WorkEvent, { kind: "cap-hit" }> = {
          kind: "cap-hit",
          at: Date.now(),
          cap,
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff",
          ...(providerCap ? { evidence: providerParkEvidence(tail as DispatchFailureEvent) } : {}),
        };
        if (capEvent.cap === "loop-detected" || capEvent.cap === "token-budget") {
          capEvent.role = (tail as { role?: RoleName }).role;
          // #543 F4(j) — the operator-facing explanation of WHAT looped (or
          // how much was spent) lives on `pipelineState.capEvidence`. The
          // structured evidence is already on the dispatch-failed event (the
          // loopEvidence / tokenBudget fields), so persist it here, at the
          // moment the cap-hit is emitted. Without this write, `explainCap`
          // renders the fallback sentence for every real cap kill — the
          // exact dead-seam shape the reviewer flagged.
          // The evidence fields exist on the `dispatch-failed` member of the
          // union only — narrow first, so the read is structural, not a
          // widened property access on both members.
          const df = tail.kind === "dispatch-failed" ? tail : undefined;
          const ev: CapEvidence | undefined =
            capEvent.cap === "loop-detected"
              ? df?.loopEvidence
                ? { kind: "loop", tool: df.loopEvidence.tool, count: df.loopEvidence.count }
                : undefined
              : df?.tokenBudget
                ? {
                    kind: "token-budget",
                    budgetTokens: df.tokenBudget.budget,
                    usedTokens: df.tokenBudget.used,
                  }
                : undefined;
          if (ev) {
            state = {
              ...state,
              pipelineState: { ...state.pipelineState, capEvidence: ev },
            };
          }
        }
        state = appendEvent(state, capEvent);
        // Set currentStep='handoff' but LEAVE status='running' so the
        // loop re-enters and runs runHandoff. runHandoff's final block
        // sets status based on the cap shape (mid-flight failure →
        // 'aborted', cap-hit verdict → 'handoff').
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, currentStep: "handoff" },
        };
        await persistCycle(ctx, state);
        trace(
          `work-driver: HALT on step="${step}" → cap="${cap}" → handoff (status set in runHandoff)`,
        );
        return { state, retry: true };
      }
      if (policy === "RETRY_ONCE" && !buried) {
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
        const budget = stepRetryBudget(classification, infra);
        if (used < budget) {
          const bumped = { ...attempts, [step]: used + 1 };
          state = {
            ...state,
            pipelineState: {
              ...state.pipelineState,
              ...(infra ? { transientRetryAttempts: bumped } : { retryAttempts: bumped }),
            },
          };
          await persistCycle(ctx, state);
          const lost = lostAttemptLine(step, used + 1, tail);
          const reason = `${failureCauseReason(tail)} · ${lost}`;
          lifecycle.emitStepRetry(step, stepOrd.num, stepOrd.total, used + 2, reason, ctx.issue);
          trace(
            `work-driver: RETRY_ONCE on step="${step}" (attempt ${used + 2}, budget=${infra ? "transient" : "semantic"}, cause=${classification.cause}) — ${lost}`,
          );
          if (infra) {
            // #1243 — provider-class failures get the minutes-floor ladder
            // (see the HALT branch above); everything else keeps the linear one.
            const wait = jitteredMs(
              providerRetryWaitMs(classification, used + 1, transientRetryBackoffMs() * (used + 1)),
              classification.waitMs ?? 0,
            );
            if (wait > 0) await providerSleep(wait, ctx.signal);
          }
          return { state, retry: true }; // re-run same step on next loop iteration
        }
        // Retry exhausted → HALT via the same cap shape. Same
        // pattern as the HALT branch above — leave status='running'
        // so the loop runs runHandoff next; runHandoff sets the
        // terminal status based on the cap shape.
        const capEvent = dispatchFailCapHit(step, state, tail);
        state = appendEvent(state, capEvent);
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, currentStep: "handoff" },
        };
        await persistCycle(ctx, state);
        trace(
          `work-driver: RETRY_ONCE exhausted on step="${step}" (cause=${classification.cause}) → cap="${capEvent.cap}" → handoff (status set in runHandoff)`,
        );
        return { state, retry: true };
      }
      // DEGRADED_OK: existing fall-through is correct (no-op here).
    }
  }

  // PR7 — multi-workstream halt-cascade router, in
  // work-driver-step-router-fanout.ts (the `branches-converged` tail of an
  // N>1 fan-out; #1243 makes its cap the provider park when every child lost
  // the same endpoint fault).
  {
    const fanout = await routeFanoutHalt(ctx, state, step);
    if (fanout !== undefined) return fanout;
  }

  // #1016 — a driver REFUSAL halts the step as a non-transient failure. N=1
  // has no branches-converged, so the fan-out check above cannot see it; the
  // refusal is never retried with backoff and never advances the cycle.
  {
    const refusals = refusedWorkstreams(state.eventLog, step);
    const parked = state.eventLog[state.eventLog.length - 1]?.kind === "cap-hit";
    if (refusals.length > 0 && !parked && STEP_FAILURE_POLICY[step] === "HALT") {
      state = appendEvent(state, {
        kind: "cap-hit",
        at: Date.now(),
        cap: `step-failed:${step}` as const,
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      });
      state = { ...state, pipelineState: { ...state.pipelineState, currentStep: "handoff" } };
      await persistCycle(ctx, state);
      trace(
        `work-driver: HALT on step="${step}" — refused: ${refusals.map((r) => `${r.id} (${r.reason})`).join("; ")} → handoff`,
      );
      return { state, retry: true };
    }
  }

  return { state, retry: false };
}
