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
import { checkAndRegisterClaims, crossGroupConflictsEnabled } from "./work-driver-path-claims.ts";
import type { WorkstreamReport } from "./work-driver-plan-calls.ts";
import { withProtectedDeferralAssumptions } from "./work-driver-plan-deferral-notice.ts";
import { findDroppedDependencyEdges } from "./work-driver-plan-deps.ts";
import { deferredProtectedPaths, withDeferredProtectedFence } from "./work-driver-plan-fence.ts";
import { planQualityReason, planSpecMismatchCap } from "./work-driver-plan-helpers.ts";
import { runCorrectiveRound } from "./work-driver-plan-quality-corrective.ts";
import {
  planQualityRecord,
  withCorrectiveDispatch,
  withDeferredProtectedDeclared,
} from "./work-driver-plan-quality-record.ts";
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
import type { PlanQualityReason } from "./workflow-state-schema.ts";
import type { PlanUnfenceSummary, Workstream } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

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
  // #1756 — the two notions `redispatched` used to carry in one flag, now two
  // names derived in one place. Both mean "THIS tail dispatched a corrective"
  // (the INPUT `redispatched` is the other thing: kill-recovery, which already
  // spent the one-shot budget).
  //
  //   - `correctiveAttempted` is set the moment the dispatch is ISSUED, before
  //     any of the `!retry` / killCause / `!retry.ok` returns. It feeds the
  //     halt's RECORD: the cycle paid for that dispatch whether or not it came
  //     back, so a park after it must not persist `redispatched: false`.
  //   - `correctiveReplacedPlan` is set only after the corrective passed every
  //     one of its own checks. It feeds the halt PREDICATE below, so a
  //     corrective that threw, was killed, or failed its own gate never clears
  //     the primary's refusal.
  //
  // Reading the input flag before the `await` is what made a clean corrective
  // unable to clear the primary's refusal.
  let correctiveAttempted = false;
  let correctiveReplacedPlan = false;
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
  // site from the live `correctiveReplacedPlan` (#1756). A corrective whose own
  // gate passed cleared the primary's verdict; a corrective that was itself
  // refused capped at its own site above.
  const halt = (state: WorkState): PlanQualityOutput => ({
    // #1756 — one place decides what a corrective means for a park. The RECORD
    // flag is the LIVE `correctiveAttempted`: this tail dispatched a corrective,
    // so a park must not persist `redispatched: false` and deny the dispatch the
    // cycle paid for — including when that dispatch threw, was killed or came
    // back not-ok, all three of which return BEFORE the assignment below and so
    // used to halt with the record saying no corrective ever ran. The PREDICATE
    // that decides whether the primary's refusal still stands is evaluated at its
    // own site from `correctiveReplacedPlan` — a corrective that threw, was
    // killed, or failed its own gate never replaced the plan, so it clears nothing.
    state: correctiveAttempted
      ? withCorrectiveDispatch(state, input, droppedEdges, unfence)
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
    // #1756 r2 — the whole round lives in `work-driver-plan-quality-corrective.ts`
    // (§12 size split, along the seam the code already had: this tail decides
    // WHETHER a corrective is owed, that module runs the one it is owed). The
    // two flags come back as answers rather than as local state the tail has to
    // reason about: `attempted` is the halt's RECORD (the cycle paid for the
    // dispatch even when it threw, was killed or came back not-ok) and
    // `replacedPlan` is the halt PREDICATE below.
    const round = await runCorrectiveRound(
      ctx,
      input,
      host,
      { noCalls, reason },
      grant,
      specMismatch?.kind,
    );
    next = round.state;
    workstreams = round.workstreams;
    if (round.unfence) unfence = round.unfence;
    if (round.raw) correctiveRaw = round.raw;
    if (round.redispatched) redispatched = true;
    if (round.repairedCleared) repairedAdded = undefined;
    correctiveAttempted = round.attempted;
    if (round.halt) return halt(round.halt);
    // #1756 — the corrective is now the plan the cycle develops: it returned,
    // was not killed, made accepted calls and passed its OWN gate. Only this
    // clears the primary's refusal at the halt site below.
    correctiveReplacedPlan = round.replacedPlan;
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
  // #1756 — the predicate is evaluated HERE, from the live
  // `correctiveReplacedPlan`, and ABOVE the claim registration: whatever the
  // shape gate concluded, a cycle must
  // neither develop a plan the spec gate refused nor reserve paths for a plan it
  // never develops. `specMismatch` is still the PRIMARY's verdict — a corrective
  // that reached this point passed its own gate, so its verdict cleared this one.
  if (input.planGateEnabled && specMismatch !== undefined && !correctiveReplacedPlan) {
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
    const claims = await checkAndRegisterClaims(ctx, next, workstreams);
    next = claims.state;
    // The claim gate's own parks (a live sibling holds a path, or the claims
    // lock refused a registration) are the last halt, and each is decided by the
    // gate's own return rather than by who appended the tail event (#1756).
    if (claims.parked) return halt(next);
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
    state: withDeferredProtectedDeclared(disclosed, deferredProtected),
    workstreams,
    halted: false,
    planQuality: planQualityRecord(input, redispatched, finalReason, droppedEdges, unfence),
  };
}
