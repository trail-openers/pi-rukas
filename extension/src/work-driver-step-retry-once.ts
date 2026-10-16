/**
 * work-driver-step-retry-once — the RETRY_ONCE branch of the PR5 halt-cascade
 * router, split out of `work-driver-step-router.ts` for the AGENTS.md §12 line
 * cap.
 *
 * Behaviour is the inline branch it came from, unchanged in every respect but
 * one (#1391): before the retry line is emitted the driver now cleans the
 * worktree the retry dispatches into, so a retried `lens-fix` no longer meets —
 * and parks on — the uncommitted residue of the child it is retrying after.
 * The account of that clean rides on the retry line.
 */

import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import {
  type FailureClass,
  failureCauseReason,
  jitteredMs,
  stepRetryBudget,
  transientRetryBackoffMs,
} from "./work-driver-failure-taxonomy.ts";
import { lostAttemptLine } from "./work-driver-retry-context.ts";
import { treeCleanLine } from "./work-driver-step-clean.ts";
import { sleep } from "./work-driver-step-sleep.ts";
import type { WorkEvent, WorkStep } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent, persistCycle } from "./workflow-state.ts";

/** The dispatch-failure members of the event union this branch reads. */
type FailureEvent = Extract<WorkEvent, { kind: "dispatch-failed" | "dispatch-failed-provider" }>;

/**
 * Retry a `RETRY_ONCE` step once, if its budget allows.
 *
 * #366 — an infrastructure fault must never decrement the SEMANTIC attempt
 * budget. Pre-fix the inline branch never consulted the classification, so one
 * 429 on `adversarial` burned the single semantic retry and the next failure —
 * of any kind — halted the cycle. Infra faults use the transient budget, same
 * as HALT-class steps do; semantic ones spend the single semantic retry.
 *
 * Returns the routed state plus `retry: true` when the caller should re-run the
 * step, or a routed state plus `retry: true` aimed at `handoff` when the budget
 * is exhausted (same cap shape as the HALT branch — `status` stays `running` so
 * `runHandoff` decides the terminal status from the cap). Returns `undefined`
 * when this is not a `RETRY_ONCE` step or the failure is buried behind a
 * fan-out's `branches-converged`, so the caller falls through to the fan-out
 * router.
 */
export async function retryOnceStep(
  ctx: CycleContext,
  stateIn: WorkState,
  tail: FailureEvent,
  step: WorkStep,
  stepOrd: { num: number; total: number },
  classification: FailureClass,
  policy: "RETRY_ONCE",
  buried: boolean,
): Promise<{ state: WorkState; retry: boolean } | undefined> {
  if (policy !== "RETRY_ONCE" || buried) return undefined;
  let state = stateIn;
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
    // #1391 — the same clean the HALT-class transient branch performs: a
    // RETRY_ONCE retry dispatches into the dead child's tree too.
    const tree = await treeCleanLine(ctx, state, step, used + 1);
    const lost = lostAttemptLine(step, used + 1, tail, tree);
    const reason = `${failureCauseReason(tail)} · ${lost}`;
    lifecycle.emitStepRetry(step, stepOrd.num, stepOrd.total, used + 2, reason, ctx.issue);
    trace(
      `work-driver: RETRY_ONCE on step="${step}" (attempt ${used + 2}, budget=${infra ? "transient" : "semantic"}, cause=${classification.cause}) — ${lost}`,
    );
    if (infra) {
      const wait = jitteredMs(transientRetryBackoffMs() * (used + 1), classification.waitMs ?? 0);
      if (wait > 0) await sleep(wait);
    }
    return { state, retry: true }; // re-run same step on next loop iteration
  }
  // Retry exhausted → HALT via the same cap shape as the HALT branch above —
  // leave status='running' so the loop runs runHandoff next; runHandoff sets
  // the terminal status based on the cap shape.
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
    `work-driver: RETRY_ONCE exhausted on step="${step}" (cause=${classification.cause}) → handoff (status set in runHandoff)`,
  );
  return { state, retry: true };
}
