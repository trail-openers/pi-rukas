/**
 * work-driver-plan-quality-pass — #1167 (size split): the deterministic
 * plan-quality tail of the plan step, split out of work-driver-plan.ts for the
 * AGENTS.md §12 500-line cap.
 *
 * Behaviour is unchanged by the split — the same sequence, in the same order:
 *
 *   1. `planQualityReason` (arithmetic over the parsed map) and, #819, the
 *      plan-to-spec gate over the reply's RAW text. An existing shape reason
 *      takes precedence in the steer: a collision is a fixable split, wrong
 *      work is not.
 *   2. the one-shot corrective re-dispatch (#754 / #818), whose OWN text is
 *      gated again — a corrective is already the cycle's budget, so a failure
 *      there HALTS;
 *   3. #1005 — the corrective may MERGE colliding workstreams but may not
 *      silently drop a `dependsOn` edge the first plan declared;
 *   4. the cross-group claim check (#571), the synthetic `default` workstream,
 *      and the single `planQuality` write (returned, not written — the caller
 *      owns the state object).
 *
 * #1167 adds the `contradictory-fence` reason to step 1 and its steer to step
 * 2; the contradiction details are computed here rather than at the call site
 * so the steer builder stays a pure formatter.
 *
 * `dispatch` and the deck/slow-recorder option builders are
 * injected so this module stays free of the driver's dispatch wiring (and free
 * of a cycle import), and so the smoke tests can drive the corrective with a
 * canned reply and no child process.
 */

import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { checkAndRegisterClaims, crossGroupConflictsEnabled } from "./work-driver-path-claims.ts";
import {
  PLAN_WORKSTREAM_EXTRA_ARGS,
  type WorkstreamReport,
  appendPlanDispatchOutcome,
  workstreamCallsOf,
} from "./work-driver-plan-calls.ts";
import { runPlanNormalisationPass } from "./work-driver-plan-coupling-pass.ts";
import { findDroppedDependencyEdges } from "./work-driver-plan-deps.ts";
import {
  planNoWorkstreamCallsCap,
  planQualityReason,
  planResultsUnreadableCap,
  planSpecMismatchCap,
} from "./work-driver-plan-helpers.ts";
import {
  findFenceContradictions,
  findPathCollisions,
  findTestSubjectSplits,
} from "./work-driver-plan-paths.ts";
import {
  type PlanSpecMismatch,
  type SpecCoverageSpec,
  planSpecMismatchReason,
} from "./work-driver-plan-spec-coverage.ts";
import {
  correctiveNoWorkstreamCallsSteer,
  correctivePlanSteer,
  correctiveTestSubjectSplitSteer,
} from "./work-driver-plan-steers.ts";
import { planCorrectiveFailureEvent, planCorrectivePrompt } from "./work-driver-plan-timeout.ts";
import type { PlanQualityReason } from "./workflow-state-schema.ts";
import type { PlanUnfenceSummary, Workstream } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

/** The state the quality tail needs from the steps above it. */
export type PlanQualityInput = {
  /** Event state after the primary plan's completion event. */
  next: WorkState;
  /**
   * What the plan dispatch this tail judges reported (#1652). Zero accepted
   * calls is the one-shot corrective's first trigger. For a killed primary this
   * is the recovery corrective's report, which is never zero here.
   */
  report: WorkstreamReport;
  /** Workstreams AFTER the fold, the coupling merge and the #1167 unfence. */
  workstreams: Record<string, Workstream>;
  /** The primary plan's RAW parsed map (for the #1005 dropped-edge check). */
  firstPlanRaw: Record<string, Workstream>;
  /** Enumerated DELIVERABLES expected to produce a diff (#378 / #792). */
  findingsCount: number;
  /** The resolved spec the #819 gate reads (deliverables only). */
  spec: SpecCoverageSpec | undefined;
  /** One read of the gate knob for the whole step (#819 round-2). */
  planGateEnabled: boolean;
  /** The kill-triggered corrective already spent this cycle's one-shot budget. */
  planKill: boolean;
  /** Whether a corrective has already run for this plan. */
  redispatched: boolean;
  /**
   * #1167 round-3 — the primary plan's unfence record (see `unfenceSummary`).
   * The corrective runs its own pass and its record replaces this one, because
   * the corrective is the plan the cycle develops.
   */
  unfence?: PlanUnfenceSummary;
};

/** Everything the tail needs from outside: dispatch, parsing, event options. */
export type PlanQualityHost = {
  dispatch: (
    host: CycleContext["host"],
    spec: { role: string; prompt: string },
    opts: Record<string, unknown>,
  ) => Promise<DispatchResult>;
  /** The primary plan's prompt — the corrective inherits it (#657). */
  prompt: string;
  /** Executor the corrective's coupling merge greps with (test seam). */
  couplingExecFn?: (
    cmd: string,
    opts?: {
      cwd?: string;
      timeout?: number;
      maxBuffer?: number;
      argv?: string[];
    },
  ) => Promise<{ stdout: string; stderr?: string }>;
  slow: (issue: number, step: "plan") => unknown;
  deck: (issue: number, step: "plan", label: string) => Record<string, unknown>;
};

/** What the tail returns. `halted` states carry their own tail event. */
export type PlanQualityOutput = {
  state: WorkState;
  workstreams: Record<string, Workstream>;
  /** True when a gate halted the step — the caller returns `state` verbatim. */
  halted: boolean;
  /** The single `planQuality` record, absent when the step halted. */
  planQuality?: NonNullable<WorkState["pipelineState"]["planQuality"]>;
};

/**
 * Runs steps 1-4. Every halt returns `halted: true` with the state that
 * carries the halting event, so the caller has exactly one shape to handle.
 */
export async function runPlanQualityTail(
  ctx: CycleContext,
  input: PlanQualityInput,
  host: PlanQualityHost,
): Promise<PlanQualityOutput> {
  let next = input.next;
  let workstreams = input.workstreams;
  let redispatched = input.redispatched;
  let firstPlanWorkstreams: Record<string, Workstream> | undefined;
  // The corrective's RAW map, set when this tail runs a corrective (the #1005
  // dropped-edge check reads it against the first plan's raw map).
  let correctiveRaw: Record<string, Workstream> | undefined;
  let droppedEdges: { from: string; to: string }[] | undefined;
  let unfence = input.unfence;

  // #1652 — a plan dispatch with no accepted call has no plan at all. Its
  // workstreams are empty, so the shape reasons below say nothing about it;
  // it takes the one corrective instead, and the budget is shared.
  const noCalls = !input.planKill && input.report.accepted === 0;
  const reason = noCalls ? undefined : planQualityReason(workstreams, input.findingsCount);
  const specMismatch =
    input.planGateEnabled && !noCalls ? planSpecMismatchReason(workstreams, input.spec) : undefined;
  // #819 round-3 — a primary refusal is never silently outlived: the tail
  // halts on any unresolved refusal, and "unresolved" means no corrective ran
  // for it (a corrective that was itself refused caps at its own site below).
  const primaryGateRefused = input.planGateEnabled && specMismatch !== undefined && !redispatched;
  const halt = (state: WorkState): PlanQualityOutput => ({
    state,
    workstreams,
    halted: true,
  });

  // The kill-triggered corrective already spent this cycle's one-shot budget,
  // so the gate below does not re-dispatch — but #819 must not develop on a
  // plan nobody checked: halt with the same cap a wrong corrective gets.
  if (input.planKill && specMismatch) {
    return halt(
      planSpecMismatchCap(
        next,
        specMismatch,
        "the one-shot plan corrective was already spent on the killed primary plan, so this plan was not re-dispatched",
      ),
    );
  }

  // #754 — the kill-triggered corrective already spent the one-shot budget;
  // the gate below must not spend it twice. #819 — a spec mismatch fires the
  // same one-shot corrective; when only the spec gate fired the steer is the
  // spec-steer (an existing reason keeps precedence: more specific diagnosis).
  if (noCalls || (!input.planKill && input.planGateEnabled && (reason || specMismatch))) {
    // #849 — the first plan's RAW workstreams, held aside for the dropped-edge
    // check. Set here (the quality gate firing on the primary's plan) so the
    // kill-triggered path leaves it undefined (pre-#1005 shape).
    firstPlanWorkstreams = input.firstPlanRaw;
    trace(correctiveTraceMessage(noCalls, reason, specMismatch?.kind));
    const steer = correctiveSteerFor(
      noCalls,
      input.report,
      workstreams,
      reason,
      input.findingsCount,
    );
    // #657 post-mortem — the corrective inherits the original prompt plus any
    // prior-handoff context; a weak model read a stale `cross-group-conflict`
    // as a live unsatisfiable precondition and burned 73.5M cache tokens
    // re-verifying it before the wall-clock kill — twice.
    const correctivePrompt = planCorrectivePrompt(host.prompt, steer);
    const label = "plan:corrective";
    const retry = await host
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
    // #819 round-3 — a corrective whose dispatch THREW is a failure of the
    // step, not an absence of one. Pre-round-3 the `if (retry)` skipped the
    // whole block on a rejection, so the step fell through to the tail,
    // recorded the PRIMARY's completion, kept its defective workstreams and
    // claimed them: the router saw a clean plan and walked into branch.
    if (!retry) {
      return halt(
        appendEvent(next, {
          kind: "dispatch-failed",
          step: "plan",
          role: "explore",
          jobId: "unknown",
          label,
          ms: 0,
          at: Date.now(),
          exitCode: null,
          errorTail:
            "[pi-rukas] the one-shot corrective plan dispatch threw and produced no result",
        }),
      );
    }
    // #819 round-3 — the kill check runs BEFORE any append and returns right
    // after, so a killed corrective gets exactly ONE `dispatch-failed`.
    // Pre-round-3 the same result went through `buildCompletionEvent` (which
    // turns any `killCause` into its own `dispatch-failed`) AND
    // `planKillFailureEvent`, appending two failure events for one kill.
    // #754 — the corrective is NEVER re-dispatched again: exactly one
    // corrective per cycle, whether the trigger was quality findings or the
    // kill above.
    if (retry.killCause) {
      return halt(appendEvent(next, await planCorrectiveFailureEvent(ctx, label, retry)));
    }
    // #1652 — the corrective's calls REPLACE the first set (no merge). Refusals
    // are recorded before the completion event, which stays the tail — and that
    // holds on a failed corrective too, so a provider error after some calls
    // does not lose what the planner got wrong.
    const retryReport = workstreamCallsOf(retry);
    const retryCompletion = await buildCompletionEvent(ctx, "plan", "explore", label, retry);
    next = appendPlanDispatchOutcome(next, label, retryReport, retryCompletion);
    // A corrective that failed without a kill (provider error, non-zero exit) is
    // a failed dispatch: its completion event is the tail, not a zero-call verdict.
    if (!retry.ok) return halt(next);
    redispatched = true;
    if (retryReport.unreadable > 0) {
      return halt(planResultsUnreadableCap(next, retryReport));
    }
    // #1652 — one corrective per cycle, and a corrective with no accepted call
    // leaves the cycle with no plan. The first set is discarded: it already
    // failed the gate, so proceeding on it would build what the gate refused.
    // Second result is final — including when it is no better. One retry,
    // never a loop; a plan step that can re-dispatch on its own verdict is a
    // plan step that can spin.
    if (retryReport.accepted === 0) {
      return halt(
        planNoWorkstreamCallsCap(
          next,
          retryReport,
          "this is the one-shot corrective plan — it was not re-dispatched and develop never ran",
        ),
      );
    }
    workstreams = retryReport.workstreams;
    correctiveRaw = retryReport.workstreams; // #1005 — the corrective's RAW map
    // #1167 round-3 / round-4 — the corrective gets the SAME normalisation the
    // primary got, through the one shared helper (`runPlanNormalisationPass`)
    // so no path can skip half of it. It used to re-run the coupling merge but
    // not the unfence, so a corrective that re-introduced an issue-contradicting
    // fence (the planner rewrites the whole `out-of-scope:` line, so this is the
    // normal case, not a corner) reached develop with a fence the primary plan
    // had already been protected from — and the develop gate parks on it. Same
    // body, same ref, same executor, and the unfence one line after the merge
    // that unions the fences back together (the order reason from
    // `runPlanNormalisationPass`).
    const correctiveNormalised = await runPlanNormalisationPass(workstreams, next, {
      repoRoot: ctx.repoRoot,
      worktrees: next.pipelineState.worktrees,
      execFn: host.couplingExecFn,
    });
    workstreams = correctiveNormalised.workstreams;
    if (correctiveNormalised.summary) unfence = correctiveNormalised.summary;
    // #819 — the gate runs AGAIN on the corrective: #818's wrong work came
    // from the corrective, not the first plan. A corrective is already the
    // cycle's one-shot budget, so a failure here HALTS.
    const correctiveMismatch = input.planGateEnabled
      ? planSpecMismatchReason(workstreams, input.spec)
      : undefined;
    if (correctiveMismatch) {
      return halt(
        planSpecMismatchCap(
          next,
          correctiveMismatch,
          "this is the one-shot corrective plan — it was not re-dispatched and develop never ran",
        ),
      );
    }
  }

  // #849 — the one-shot corrective re-plan is free to MERGE the colliding
  // workstreams but not to silently drop a dependsOn edge the first plan had.
  // The match is id-priority with a path-set signature fallback for renamed
  // workstreams; a merged pair never flags. The comparison is against the
  // corrective's RAW map — `workstreams` is by now the POST-MERGE map.
  if (firstPlanWorkstreams && redispatched) {
    const dropped = findDroppedDependencyEdges(firstPlanWorkstreams, correctiveRaw ?? workstreams);
    if (dropped.length > 0) {
      droppedEdges = dropped;
      trace(
        `work-driver: plan quality — corrective dropped ${dropped.length} dependsOn edge(s) without merging: ${dropped
          .map((e: { from: string; to: string }) => `${e.from}→${e.to}`)
          .join(", ")}`,
      );
    }
  }

  // #571 — cross-group claim check: detect sibling overlaps BEFORE registering.
  // Parking early costs one plan dispatch, not a full develop-to-commit burn.
  if (crossGroupConflictsEnabled()) {
    next = await checkAndRegisterClaims(ctx, next, workstreams);
  }
  // #819 round-3 — a reason a halt path already persisted survives this write
  // (it is the fallback of `finalReason` below) and trips the assertion under
  // it: the field's purpose is that `lastCapHit` is not the only reader of the
  // verdict, so a halted cycle never loses it to the tail's object.
  const haltReason = next.pipelineState.planQuality?.reason;
  if (haltReason === "plan-spec-mismatch") {
    throw new Error(
      "work-driver: runPlan reached its final return with planQuality.reason = plan-spec-mismatch — the plan-to-spec halt must return before the gates, the claims and the synthetic default workstream",
    );
  }
  if (primaryGateRefused) {
    // The primary's refusal has no earlier `return` when the corrective ran
    // and was judged on its OWN text (a corrective whose paths cover the spec
    // leaves `correctiveMismatch` silent). Whatever the shape gate concluded,
    // the cycle must not reach develop on a plan the spec gate refused.
    return halt(
      planSpecMismatchCap(
        next,
        specMismatch as PlanSpecMismatch,
        "the primary plan carried a shape the plan-to-spec gate refuses, and no corrective plan replaced it",
      ),
    );
  }
  const finalReason =
    droppedEdges && droppedEdges.length > 0 ? "dropped-dependencies" : (reason ?? haltReason);
  return {
    state: next,
    workstreams,
    halted: false,
    planQuality: {
      findingsCount: input.findingsCount,
      redispatched,
      ...(finalReason ? { reason: finalReason } : {}),
      ...(droppedEdges ? { droppedEdges } : {}),
      // #1167 round-3 — the unfence's own record, so the four silences (no
      // fences, unreadable issue body, identifier cap, git failure) are
      // distinguishable in the state file rather than only in `trace()`.
      ...(unfence ? { unfence } : {}),
    },
  };
}

/** The trace line for the corrective's trigger: zero calls, or a plan-quality reason. */
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

/** The steer the corrective carries: zero calls, the test-subject split, or the general plan steer. */
function correctiveSteerFor(
  noCalls: boolean,
  report: WorkstreamReport,
  workstreams: Record<string, Workstream>,
  reason: PlanQualityReason | undefined,
  findingsCount: number,
): string {
  if (noCalls) return correctiveNoWorkstreamCallsSteer(report.refused);
  if (reason === "test-subject-split") {
    return correctiveTestSubjectSplitSteer(findTestSubjectSplits(workstreams));
  }
  return correctivePlanSteer(
    reason ?? "plan-spec-mismatch",
    findingsCount,
    Object.keys(workstreams).length,
    findPathCollisions(workstreams),
    // #1167 — the new reason's details. Cheap and pure, so computed once here
    // for whichever steer runs.
    findFenceContradictions(workstreams),
  );
}
