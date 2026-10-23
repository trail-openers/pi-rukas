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
import { withProtectedDeferralAssumptions } from "./work-driver-plan-deferral-notice.ts";
import { findDroppedDependencyEdges } from "./work-driver-plan-deps.ts";
import { deferredProtectedPaths, withDeferredProtectedFence } from "./work-driver-plan-fence.ts";
import {
  planNoWorkstreamCallsCap,
  planQualityReason,
  planResultsUnreadableCap,
  planSpecMismatchCap,
} from "./work-driver-plan-helpers.ts";
import {
  repairOmittedDeliverablePaths,
  withOmittedPathAssumption,
} from "./work-driver-plan-repair.ts";
import {
  type PlanSpecMismatch,
  type SpecCoverageSpec,
  planSpecMismatchReason,
  protectedDeferralsOf,
  undeclarableSlotsOf,
} from "./work-driver-plan-spec-coverage.ts";
import { correctiveSteerFor } from "./work-driver-plan-steers.ts";
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
  // #1756 — the two notions `redispatched` used to carry in one flag. The INPUT
  // flag is kill-recovery (#754: a killed primary already spent the one-shot
  // budget, so the tail must not spend it twice); THIS one is "this tail
  // dispatched a corrective and kept its plan". The halt predicate reads the
  // live value at the halt site — reading the input flag before the `await` is
  // what made a clean corrective unable to clear the primary's refusal.
  let correctiveRan = false;
  let unfence = input.unfence;
  // The paths the repair appended to the primary plan. Disclosed at the end only
  // when that plan is the one that reaches develop: a corrective replaces it.
  let repairedAdded: readonly string[] | undefined;

  // #1652 — a plan dispatch with no accepted call has no plan at all. Its
  // workstreams are empty, so the shape reasons below say nothing about it;
  // it takes the one corrective instead, and the budget is shared.
  const noCalls = !input.planKill && input.report.accepted === 0;
  // The single-workstream repair runs before the shape reason and the gate, so
  // a plan that only omitted spec paths is repaired rather than re-dispatched.
  const grant = ctx.protectedGrant ?? [];
  // A refused or unreadable call is a second defect, so the repair stands down.
  const cleanReport = input.report.refused.length === 0 && input.report.unreadable === 0;
  // A killed primary is not repaired: the one-shot corrective is already spent.
  const repair =
    input.planGateEnabled && !noCalls && cleanReport && !input.planKill
      ? repairOmittedDeliverablePaths(workstreams, input.spec, grant, (refusal) =>
          trace(
            `work-driver: plan-to-spec gate declined the single-workstream repair (${refusal}) — the gate runs as before`,
          ),
        )
      : undefined;
  if (repair) {
    workstreams = repair.workstreams;
    repairedAdded = repair.added;
    trace(
      `work-driver: plan-to-spec gate added spec deliverable path(s) the single-workstream plan omitted: ${repair.added.join(", ")}`,
    );
  }
  const reason = noCalls ? undefined : planQualityReason(workstreams, input.findingsCount);
  // #1642 — the gate does not require a deliverable whose every path is protected
  // and ungranted; the trace is the record that it was not required.
  for (const d of protectedDeferralsOf(input.spec, grant)) {
    trace(
      `work-driver: plan-to-spec gate deferred deliverable ${d.id} (${d.paths.join(", ")}) — protected path(s) with no --allow-protected grant, so the plan is not required to cover them`,
    );
  }
  // #1707 — the mirror trace for the OTHER exemption: a slot the planner may
  // not declare (a glob or `<name>` template) is exempted from the coverage
  // requirement, and without this line a deliverable whose slots were all
  // exempted leaves the gate judging nothing with nothing to show for it.
  // Gated on the SAME condition the gate runs under — with the gate off (or no
  // accepted call, which the zero-call corrective owns) nothing was exempted,
  // and a trace for a gate that never ran is indistinguishable from a real one.
  if (input.planGateEnabled && !noCalls) {
    for (const d of undeclarableSlotsOf(input.spec)) {
      trace(
        `work-driver: plan-to-spec gate exempted deliverable ${d.id} slot(s) no plan may declare (${d.paths.join(", ")}) — patterns stay measured at converge, where a real diff can answer them`,
      );
    }
  }
  const specMismatch =
    input.planGateEnabled && !noCalls
      ? planSpecMismatchReason(workstreams, input.spec, grant)
      : undefined;
  // #819 round-3 — a primary refusal is never silently outlived: the tail
  // halts on any UNRESOLVED refusal, and "unresolved" is decided at the halt
  // site from the live `correctiveRan` (#1756). A corrective whose own gate
  // passed cleared the primary's verdict; a corrective that was itself refused
  // capped at its own site above.
  const halt = (state: WorkState, correctiveDispatched = false): PlanQualityOutput => ({
    // A park that follows a corrective records that the corrective ran (#1756).
    // The halt predicate itself is evaluated at the halt site below, from the
    // live `correctiveRan`, never from a const captured before the dispatch.
    state: correctiveDispatched
      ? withCorrectiveDispatch(state, input, redispatched, droppedEdges, unfence)
      : state,
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
      // The ORIGINAL plan: a repaired path was never written by the planner.
      input.workstreams,
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
    if (!retry.ok) return halt(next, true);
    redispatched = true;
    // #1756 — the corrective the TAIL dispatched, judged by the halt predicate.
    correctiveRan = true;
    repairedAdded = undefined;
    if (retryReport.unreadable > 0) {
      return halt(planResultsUnreadableCap(next, retryReport), true);
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
        true,
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
      ? planSpecMismatchReason(workstreams, input.spec, grant)
      : undefined;
    if (correctiveMismatch) {
      return halt(
        planSpecMismatchCap(
          next,
          correctiveMismatch,
          "this is the one-shot corrective plan — it was not re-dispatched and develop never ran",
        ),
        true,
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

  // #1676 — a protected path the gate deferred is fenced in every workstream's
  // outOfScope, so develop names it and the scope gate enforces it. Only when the
  // gate ran: nothing is deferred otherwise. Returned in `workstreams`, which the
  // caller writes to pipelineState, so resume and the corrective round see it.
  // The same list is persisted with the fence (see the return below).
  const deferredProtected = input.planGateEnabled
    ? deferredProtectedPaths(input.spec, grant)
    : undefined;
  if (deferredProtected !== undefined) {
    if (input.spec === undefined) {
      trace(
        "work-driver: plan tail has no normalised spec — no protected deferral can be computed, so no protected-path fence is appended",
      );
    }
    workstreams = withDeferredProtectedFence(workstreams, deferredProtected);
  }
  const haltReason = next.pipelineState.planQuality?.reason;
  if (haltReason === "plan-spec-mismatch") {
    throw new Error(
      "work-driver: runPlan reached its final return with planQuality.reason = plan-spec-mismatch — the plan-to-spec halt must return before the gates, the claims and the synthetic default workstream",
    );
  }
  // #1756 — the predicate is evaluated HERE, from the live `correctiveRan`, and
  // ABOVE the claim registration: whatever the shape gate concluded, a cycle must
  // neither develop a plan the spec gate refused nor reserve paths for a plan it
  // never develops. `specMismatch` is still the PRIMARY's verdict — a corrective
  // that reached this point passed its own gate, so its verdict cleared this one.
  if (input.planGateEnabled && specMismatch !== undefined && !correctiveRan) {
    return halt(
      planSpecMismatchCap(
        next,
        specMismatch as PlanSpecMismatch,
        "the primary plan carried a shape the plan-to-spec gate refuses, and no corrective plan replaced it",
      ),
    );
  }
  // #571 — cross-group claim check: detect sibling overlaps BEFORE registering,
  // so a cycle whose plan is refused or whose paths a live sibling holds never
  // leaves claims behind (#1756 moves this below the halt decision). Parking
  // early costs one plan dispatch, not a full develop-to-commit burn.
  if (crossGroupConflictsEnabled()) {
    next = await checkAndRegisterClaims(ctx, next, workstreams);
    // The claim gate's own parks (a live sibling holds a path, or the claims
    // lock refused a registration) are the last halt, and each leaves its cap-hit
    // as the tail event (#1756 moves this block below the spec-gate halt).
    const lastEvent = next.eventLog[next.eventLog.length - 1];
    if (lastEvent?.kind === "cap-hit") return halt(next, correctiveRan);
  }
  const finalReason =
    droppedEdges && droppedEdges.length > 0 ? "dropped-dependencies" : (reason ?? haltReason);
  // #1642 review — a deferred protected path is disclosed on the spec (the PR
  // body), not only traced. Only when the gate ran: nothing was deferred otherwise.
  const repaired =
    repairedAdded !== undefined ? withOmittedPathAssumption(next, repairedAdded) : next;
  const disclosed = input.planGateEnabled
    ? withProtectedDeferralAssumptions(repaired, input.spec, grant)
    : repaired;
  return {
    state: declaredState(disclosed, deferredProtected),
    workstreams,
    halted: false,
    planQuality: planQualityRecord(input, redispatched, finalReason, droppedEdges, unfence),
  };
}

/**
 * #1756 — a halt that follows a corrective dispatch must not persist
 * `planQuality.redispatched: false` and deny the dispatch the cycle paid for.
 * The parks below all follow a corrective whose calls were accepted, so the
 * record is written from this tail's own live values (the same builder the
 * success return uses) rather than read back from a park that never recorded
 * one. `plan-spec-mismatch` is what each of those caps parks on; the claims
 * gate's own caps carry their own verdict and keep their reason untouched.
 * No-op when the state already says a corrective ran.
 */
function withCorrectiveDispatch(
  state: WorkState,
  input: PlanQualityInput,
  redispatched: boolean,
  droppedEdges: { from: string; to: string }[] | undefined,
  unfence: PlanUnfenceSummary | undefined,
): WorkState {
  if (state.pipelineState.planQuality?.redispatched) return state;
  const prior = state.pipelineState.planQuality;
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      planQuality: {
        ...planQualityRecord(input, redispatched, prior?.reason, droppedEdges, unfence),
        ...(prior?.reason ? {} : { reason: "plan-spec-mismatch" as const }),
      },
    },
  };
}

/** The state the success return carries: the disclosures, plus any deferred fence. */
function declaredState(disclosed: WorkState, deferredProtected: string[] | undefined): WorkState {
  return deferredProtected === undefined
    ? disclosed
    : {
        ...disclosed,
        pipelineState: { ...disclosed.pipelineState, deferredProtected },
      };
}

/**
 * The single `planQuality` record the caller persists. `redispatched` is the
 * LIVE flag: true whenever this cycle ran a corrective, whether the tail's own
 * (#1756 — a halt must not persist a verdict that denies the corrective
 * happened) or the kill-recovery one.
 */
function planQualityRecord(
  input: PlanQualityInput,
  redispatched: boolean,
  finalReason: PlanQualityReason | undefined,
  droppedEdges: { from: string; to: string }[] | undefined,
  unfence: PlanUnfenceSummary | undefined,
): NonNullable<WorkState["pipelineState"]["planQuality"]> {
  return {
    findingsCount: input.findingsCount,
    redispatched,
    ...(finalReason ? { reason: finalReason } : {}),
    ...(droppedEdges ? { droppedEdges } : {}),
    // #1167 round-3 — the unfence's own record, so the four silences (no
    // fences, unreadable issue body, identifier cap, git failure) are
    // distinguishable in the state file rather than only in `trace()`.
    ...(unfence ? { unfence } : {}),
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
