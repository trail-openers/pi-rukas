/**
 * work-driver-plan-quality-corrective — #1756 r2 (size split): the one-shot
 * corrective re-dispatch, split out of `work-driver-plan-quality-pass.ts` for
 * the AGENTS.md §12 500-line cap.
 *
 * The seam is the one the code already had: the tail decides WHETHER a
 * corrective is owed (zero accepted calls, a plan-quality reason, or a spec
 * mismatch); this module runs the one it is owed and reports what came back.
 * Exactly one dispatch happens here — #754's rule that a cycle gets one
 * corrective whether the trigger was quality findings or a killed primary — so
 * "did we run one" and "did it become the plan" are decided here and returned,
 * never inferred by the caller from the shape of the event tail.
 *
 * The two flags are deliberately separate returns (#1756):
 *
 *   - `attempted` is set the moment the dispatch is ISSUED, before the
 *     `!retry` / `killCause` / `!retry.ok` returns. It is the halt's RECORD:
 *     the cycle paid for that dispatch whether or not it came back, and a park
 *     that persisted `redispatched: false` denied a dispatch the state file
 *     then could not account for.
 *   - `replacedPlan` is set only after the corrective passed every one of its
 *     own checks. It is the halt PREDICATE: a corrective that threw, was
 *     killed, or failed its own gate never became the plan, so it clears
 *     nothing of the primary's refusal.
 *
 * `dispatch` / `prompt` / `slow` / `deck` / `couplingExecFn` come from the
 * tail's host, so this module stays free of the driver's dispatch wiring (and
 * of a cycle import) and the smoke tests can drive the corrective with a
 * canned reply and no child process.
 */

import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import {
  PLAN_WORKSTREAM_EXTRA_ARGS,
  type WorkstreamReport,
  appendPlanDispatchOutcome,
  workstreamCallsOf,
} from "./work-driver-plan-calls.ts";
import { runPlanNormalisationPass } from "./work-driver-plan-coupling-pass.ts";
import {
  planNoWorkstreamCallsCap,
  planResultsUnreadableCap,
  planSpecMismatchCap,
} from "./work-driver-plan-helpers.ts";
import type { PlanQualityHost, PlanQualityInput } from "./work-driver-plan-quality-pass.ts";
import { planSpecMismatchReason } from "./work-driver-plan-spec-coverage.ts";
import { correctiveSteerFor } from "./work-driver-plan-steers.ts";
import { planCorrectiveFailureEvent, planCorrectivePrompt } from "./work-driver-plan-timeout.ts";
import type { PlanQualityReason, PlanUnfenceSummary, Workstream } from "./workflow-state-schema.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Why the cycle owes a corrective, computed by the tail before it calls here. */
export type CorrectiveTrigger = {
  /** #1652 — the primary made no accepted `report_workstream` call. */
  noCalls: boolean;
  /** The shape reason the primary's plan earned, if any. */
  reason: PlanQualityReason | undefined;
};

/** What the corrective round decided, for the tail's halt, record and repair. */
export type CorrectiveRoundResult = {
  /** Event state after this round's appends — the caller continues from it. */
  state: WorkState;
  /** The corrective's normalised workstreams, or the primary's when none landed. */
  workstreams: Record<string, Workstream>;
  /** The corrective's RAW map (#1005's dropped-edge comparison). */
  raw?: Record<string, Workstream>;
  /** The corrective's own unfence record, which replaces the primary's. */
  unfence?: PlanUnfenceSummary;
  /** True once the dispatch was ISSUED — feeds the halt's RECORD. */
  attempted: boolean;
  /** True only when the corrective became the plan — feeds the halt PREDICATE. */
  replacedPlan: boolean;
  /** True when a corrective was accepted: the queue's one-shot budget is spent. */
  redispatched: boolean;
  /** True when the corrective replaced the primary, so its repair disclosure goes. */
  repairedCleared: boolean;
  /** A halt the caller returns verbatim (the state carries the halting event). */
  halt?: WorkState;
};

/**
 * The trace line for the corrective's trigger: zero calls, or a plan-quality
 * reason. `mismatchKind` is the spec gate's verdict, appended as a secondary
 * diagnosis when a shape reason took precedence in the steer.
 */
function correctiveTraceMessage(
  noCalls: boolean,
  reason: PlanQualityReason | undefined,
  mismatchKind: string | undefined,
): string {
  if (noCalls)
    return "work-driver: plan made no accepted report_workstream call — re-dispatching once";
  const also = reason && mismatchKind ? ` (also plan-spec-mismatch: ${mismatchKind})` : "";
  return `work-driver: plan quality — ${reason ?? mismatchKind}, re-dispatching once${also}`;
}

/**
 * Run the cycle's one corrective. Every failure returns `halt` — a corrective
 * IS the budget, so nothing here re-dispatches and nothing here falls through
 * to "the primary's plan was fine after all".
 */
export async function runCorrectiveRound(
  ctx: CycleContext,
  input: PlanQualityInput,
  host: PlanQualityHost,
  trigger: CorrectiveTrigger,
  grant: readonly string[],
  mismatchKind: string | undefined,
): Promise<CorrectiveRoundResult> {
  let next = input.next;
  let workstreams = input.workstreams;
  let unfence = input.unfence;
  /** Snapshot the current outcome; `halt` (when given) is what the caller returns. */
  const done = (patch: Partial<CorrectiveRoundResult>): CorrectiveRoundResult => ({
    state: next,
    workstreams,
    unfence,
    attempted: false,
    replacedPlan: false,
    redispatched: false,
    repairedCleared: false,
    ...patch,
  });

  trace(correctiveTraceMessage(trigger.noCalls, trigger.reason, mismatchKind));
  const steer = correctiveSteerFor(
    trigger.noCalls,
    input.report,
    // The ORIGINAL plan: a repaired path was never written by the planner.
    input.workstreams,
    trigger.reason,
    input.findingsCount,
  );
  // #657 post-mortem — the corrective inherits the original prompt plus any
  // prior-handoff context; a weak model read a stale `cross-group-conflict` as
  // a live unsatisfiable precondition and burned 73.5M cache tokens
  // re-verifying it before the wall-clock kill — twice.
  const correctivePrompt = planCorrectivePrompt(host.prompt, steer);
  const label = "plan:corrective";
  // #1756 r2 — the record is set at the DISPATCH, not at the return: a
  // corrective that threw, was killed or came back not-ok still cost this
  // cycle a dispatch, and each of the three returns below happens before any
  // later assignment could run.
  const attempted = true;
  const retry: DispatchResult | undefined = await host
    .dispatch(
      ctx.host,
      { role: "explore", prompt: correctivePrompt },
      {
        label,
        onSlow: host.slow(ctx.issue, "plan"),
        deck: host.deck(ctx.issue, "plan", label),
        extraArgs: PLAN_WORKSTREAM_EXTRA_ARGS,
      },
    )
    .catch(() => undefined);
  // #819 round-3 — a corrective whose dispatch THREW is a failure of the step,
  // not an absence of one. Pre-round-3 the `if (retry)` skipped the whole
  // block on a rejection, so the step fell through to the tail, recorded the
  // PRIMARY's completion, kept its defective workstreams and claimed them: the
  // router saw a clean plan and walked into branch.
  if (!retry) {
    return done({
      attempted,
      halt: appendEvent(next, {
        kind: "dispatch-failed",
        step: "plan",
        role: "explore",
        jobId: "unknown",
        label,
        ms: 0,
        at: Date.now(),
        exitCode: null,
        errorTail: "[pi-rukas] the one-shot corrective plan dispatch threw and produced no result",
      }),
    });
  }
  // #819 round-3 — the kill check runs BEFORE any append and returns right
  // after, so a killed corrective gets exactly ONE `dispatch-failed`.
  // Pre-round-3 the same result went through `buildCompletionEvent` (which
  // turns any `killCause` into its own `dispatch-failed`) AND
  // `planKillFailureEvent`, appending two failure events for one kill.
  // #754 — the corrective is NEVER re-dispatched again: exactly one corrective
  // per cycle, whether the trigger was quality findings or a kill.
  if (retry.killCause) {
    return done({
      attempted,
      halt: appendEvent(next, await planCorrectiveFailureEvent(ctx, label, retry)),
    });
  }
  // #1652 — the corrective's calls REPLACE the first set (no merge). Refusals
  // are recorded before the completion event, which stays the tail — and that
  // holds on a failed corrective too, so a provider error after some calls does
  // not lose what the planner got wrong.
  const retryReport: WorkstreamReport = workstreamCallsOf(retry);
  const retryCompletion = await buildCompletionEvent(ctx, "plan", "explore", label, retry);
  next = appendPlanDispatchOutcome(next, label, retryReport, retryCompletion);
  // A corrective that failed without a kill (provider error, non-zero exit) is
  // a failed dispatch: its completion event is the tail, not a zero-call verdict.
  if (!retry.ok) return done({ attempted, halt: next });
  // #1756 — the corrective the TAIL dispatched returned a result: the cycle
  // has spent its one-shot budget on a real second plan, so the primary's
  // repair disclosure no longer describes what reaches develop.
  const redispatched = true;
  const repairedCleared = true;
  if (retryReport.unreadable > 0) {
    return done({
      attempted,
      redispatched,
      repairedCleared,
      halt: planResultsUnreadableCap(next, retryReport),
    });
  }
  // #1652 — one corrective per cycle, and a corrective with no accepted call
  // leaves the cycle with no plan. The first set is discarded: it already
  // failed the gate, so proceeding on it would build what the gate refused.
  // Second result is final — including when it is no better. One retry, never
  // a loop; a plan step that can re-dispatch on its own verdict is one that can
  // spin.
  if (retryReport.accepted === 0) {
    return done({
      attempted,
      redispatched,
      repairedCleared,
      halt: planNoWorkstreamCallsCap(
        next,
        retryReport,
        "this is the one-shot corrective plan — it was not re-dispatched and develop never ran",
      ),
    });
  }
  workstreams = retryReport.workstreams;
  const raw = retryReport.workstreams; // #1005 — the corrective's RAW map
  // #1167 round-3 / round-4 — the corrective gets the SAME normalisation the
  // primary got, through the one shared helper (`runPlanNormalisationPass`) so
  // no path can skip half of it. It used to re-run the coupling merge but not
  // the unfence, so a corrective that re-introduced an issue-contradicting
  // fence (the planner rewrites the whole `out-of-scope:` line, so this is the
  // normal case, not a corner) reached develop with a fence the primary plan
  // had already been protected from — and the develop gate parks on it.
  const correctiveNormalised = await runPlanNormalisationPass(workstreams, next, {
    repoRoot: ctx.repoRoot,
    worktrees: next.pipelineState.worktrees,
    execFn: host.couplingExecFn,
  });
  workstreams = correctiveNormalised.workstreams;
  if (correctiveNormalised.summary) unfence = correctiveNormalised.summary;
  // #819 — the gate runs AGAIN on the corrective: #818's wrong work came from
  // the corrective, not the first plan. A corrective is already the cycle's
  // one-shot budget, so a failure here HALTS.
  const correctiveMismatch = input.planGateEnabled
    ? planSpecMismatchReason(workstreams, input.spec, grant)
    : undefined;
  if (correctiveMismatch) {
    return done({
      attempted,
      redispatched,
      repairedCleared,
      raw,
      halt: planSpecMismatchCap(
        next,
        correctiveMismatch,
        "this is the one-shot corrective plan — it was not re-dispatched and develop never ran",
      ),
    });
  }
  // #1756 — the corrective is now the plan the cycle develops: it returned,
  // was not killed, made accepted calls and passed its OWN gate. Only this
  // clears the primary's refusal at the tail's halt site.
  return done({ attempted, redispatched, repairedCleared, raw, replacedPlan: true });
}
