/**
 * work-driver-step-router — post-step outcome routing for runWorkDriver's
 * main loop. Extracted from work-driver.ts (issue #171 file-size hygiene).
 * Called once per loop iteration after `runStep` returns: emits the
 * scrollback lifecycle line, applies the PR5 single-dispatch and PR7
 * multi-workstream halt-cascade routers, and returns whether the caller
 * should `continue` (retry / re-entry) rather than fall through to the
 * `nextStep()` transition.
 */

import * as lifecycle from "./lifecycle-events.ts";
import type { RoleName } from "./roles.ts";
import { drainSlowEvents, foldSlowEvents } from "./slow-events.ts";
import { trace } from "./trace.ts";
import { capKilledString } from "./work-driver-cap-killed.ts";
import { STEP_FAILURE_POLICY } from "./work-driver-context.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { dispatchTokens } from "./work-driver-cycle-total.ts";
import {
  classifyFailureCause,
  failureCauseReason,
  failureCauseReasonForClass,
  jitteredMs,
  transientRetryBackoffMs,
  transientRetryEnabled,
} from "./work-driver-failure-taxonomy.ts";
import { lostAttemptLine } from "./work-driver-retry-context.ts";
import { refusedWorkstreams } from "./work-driver-step-refusal.ts";
import type { CapEvidence } from "./workflow-state-cap.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import { type WorkState, type WorkStep, appendEvent, persistCycle } from "./workflow-state.ts";

/** #366 — injectable sleep; the offline suite must never actually sleep. */
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** Test seam. Returns a restore function. */
export function __setSleepFn(fn: (ms: number) => Promise<void>): () => void {
  const prev = sleepFn;
  sleepFn = fn;
  return () => {
    sleepFn = prev;
  };
}

/** Step completed — mark failure in the lifecycle line, then apply the
 * PR5 / PR7 halt-cascade routers. Returns `retry: true` when the caller
 * should `continue` (retry / re-entry) rather than reach `nextStep()`. */
/**
 * The dispatch failure this step ended on, if any.
 * A single-dispatch step ends ON its failure; a fan-out step ends on
 * `branches-converged` with the per-child failures several events back.
 * The scan is bounded by `branches-fanned-out` so it never reaches back
 * into a previous step. All children must have failed for this to
 * return a failure: if any workstream succeeded, the step's problem is
 * not purely transient and re-running it is not the answer.
 */
export function failureEventOf(events: readonly WorkEvent[]): WorkEvent | undefined {
  const last = events[events.length - 1];
  if (last?.kind === "dispatch-failed" || last?.kind === "dispatch-failed-provider") return last;
  if (last?.kind !== "branches-converged") return undefined;
  if (last.verdicts.some((v: { ok: boolean }) => v.ok)) return undefined;

  let failure: WorkEvent | undefined;
  let refused = false;
  for (let i = events.length - 2; i >= 0; i--) {
    const e = events[i];
    if (!e || e.kind === "branches-fanned-out") break;
    // #1016 — a driver refusal is not transient, and a fan-out that contains
    // one is not a transient failure even when a sibling dispatch also failed:
    // re-running it would re-refuse the same workstream. Decline the retry.
    if (e.kind === "branch-completed" && e.refused) refused = true;
    if (!failure && (e.kind === "dispatch-failed" || e.kind === "dispatch-failed-provider")) {
      failure = e;
    }
  }
  return refused ? undefined : failure;
}

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
      // #1297 — a taxonomy-final provider fault is one the retry budget
      // cannot clear: either the loop saw the same error ≥2 children in a row
      // (providerRepeats ≥ 2 — the provider is still failing the same way),
      // or the classified cause carries zero retries (quota-window, undated
      // 429, spend cap, model-not-found). Neither kind may be re-dispatched
      // by the SEMANTIC one-shot below or the transient budget.
      const finalProviderFault =
        ((lastEvent as { providerRepeats?: number }).providerRepeats ?? 0) >= 2 ||
        classification.maxRetries === 0;
      const semanticRetryAvailable =
        !finalProviderFault &&
        policy === "RETRY_ONCE" &&
        (state.pipelineState.retryAttempts?.[step] ?? 0) < 1;
      const transientRetryAvailable =
        !finalProviderFault &&
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
      // #1297 — a taxonomy-final provider fault (the loop saw the same error
      // ≥2 children in a row, or the classified cause carries zero retries)
      // is never re-dispatched: waiting cannot clear a provider still failing
      // the same way, so the step halts straight through to the cap below.
      const finalFault =
        ((tail as { providerRepeats?: number }).providerRepeats ?? 0) >= 2 ||
        classification.maxRetries === 0;
      if (
        policy === "HALT" &&
        !finalFault &&
        transientRetryEnabled() &&
        classification.shouldRetry
      ) {
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
          const base = transientRetryBackoffMs() * (used + 1);
          const backoff = jitteredMs(base, classification.waitMs ?? 0);
          if (backoff > 0) await sleepFn(backoff);
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
              : (`step-failed:${step}` as const));
        const capEvent: Extract<WorkEvent, { kind: "cap-hit" }> = {
          kind: "cap-hit",
          at: Date.now(),
          cap,
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff",
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
        // #1297 — a taxonomy-final provider fault (the loop saw the same error
        // ≥2 children in a row, or the classified cause carries zero retries)
        // is not infra: the provider is still failing the same way (or the
        // cause cannot be cleared by waiting), so no budget applies and the
        // step parks immediately via the exhausted branch below.
        const finalFault =
          ((tail as { providerRepeats?: number }).providerRepeats ?? 0) >= 2 ||
          classification.maxRetries === 0;
        const infra =
          !finalFault && classification.cause !== "crashed-unknown" && classification.shouldRetry;
        const attempts = infra
          ? (state.pipelineState.transientRetryAttempts ?? {})
          : (state.pipelineState.retryAttempts ?? {});
        const used = attempts[step] ?? 0;
        const budget = finalFault ? 0 : infra ? classification.maxRetries : 1;
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
            `work-driver: RETRY_ONCE on step="${step}" (attempt ${used + 2}, budget=${infra ? "transient" : "semantic"}) — ${lost}`,
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
        await persistCycle(ctx, state);
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
        await persistCycle(ctx, state);
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
