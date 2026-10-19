/**
 * work-driver-plan — Step 2 (plan) handler + explore/plan reply parsers.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene).
 * `sliceMarkdownSection` is exported because work-driver-branch-develop.ts's
 * `parseWorktreesBlock` reuses the same fenced-section slicer.
 */

import fs from "node:fs/promises";
import { slowRecorder } from "./slow-events.ts";
import { trace } from "./trace.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import { extractListField, sliceMarkdownSection } from "./work-driver-plan-parse.ts";

// Re-exported: several modules read plan/spec markdown through this module.
export {
  sliceMarkdownSection,
  splitOutsideParens,
} from "./work-driver-plan-parse.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import type { DispatchResult } from "./types.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { issueImagesFor } from "./work-driver-issue-images.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { checkAndRegisterClaims, crossGroupConflictsEnabled } from "./work-driver-path-claims.ts";
import {
  foldPortPlan,
  portPlanSection,
  portReferenceForCycle,
} from "./work-driver-plan-contract.ts";
import { runPlanNormalisationPass } from "./work-driver-plan-coupling-pass.ts";
import { runPlanQualityTail } from "./work-driver-plan-quality-pass.ts";
import { planSpecMismatchReason } from "./work-driver-plan-spec-coverage.ts";
import { execp } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema-workstreams.ts";
// #679 — the CANONICAL planQualityReason / correctivePlanSteer / steer builders
// live in work-driver-plan-helpers.ts; this module re-exports them so existing
// importers (smoke tests, cross-module consumers) keep their paths. The stale
// duplicate copy that used to sit here was deleted — one function, one module.
export {
  countEnumeratedFindings,
  countFindingsForCycle,
  findDroppedDependencyEdges,
  planQualityEnabled,
  planQualityReason,
  planCorrectivePrompt,
  planDispatchTimeoutMs,
  planTimeoutCorrective,
} from "./work-driver-plan-helpers.ts";
export { maxWorkstreams } from "./work-driver-plan-workstreams.ts";
export {
  type ExploreVerdict,
  parseExploreVerdict,
  parsePerIssueVerdicts,
} from "./work-driver-plan-verdicts.ts";
export {
  findUncoveredDeliverables,
  planSpecMismatchReason,
} from "./work-driver-plan-spec-coverage.ts";
// #1167 (size split) — the corrective steers moved to work-driver-plan-steers.ts
// so this step handler stays inside the §12 cap; the re-export keeps every
// existing importer's path working, which is the whole reason they live here.
export {
  correctivePlanSteer,
  correctiveTestSubjectSplitSteer,
} from "./work-driver-plan-steers.ts";
// #819 round-3 — the gate's HALT is now reachable from `runPlan`'s own tail (the
// backstop under the `primaryGateRefused` assertion), so a caller that reads the
// gate's verdict must be able to read the halt it produces from the same module.
export { planSpecMismatchCap } from "./work-driver-plan-helpers.ts";
import {
  PLAN_WORKSTREAM_EXTRA_ARGS,
  type WorkstreamReport,
  appendPlanDispatchOutcome,
  checkWorkstreamReporter,
  emptyWorkstreamReport,
  workstreamCallsOf,
} from "./work-driver-plan-calls.ts";
import {
  correctivePlanSteer,
  correctiveTestSubjectSplitSteer,
  countFindingsForCycle,
  findDroppedDependencyEdges,
  planDispatchTimeoutMs,
  planNoWorkstreamCallsCap,
  planQualityEnabled,
  planQualityReason,
  planResultsUnreadableCap,
  planTimeoutCorrective,
  planTimeoutKill,
} from "./work-driver-plan-helpers.ts";
import { planPromptInputsOf } from "./work-driver-plan-inputs.ts";
import {
  findFenceContradictions,
  findPathCollisions,
  findTestSubjectSplits,
} from "./work-driver-plan-paths.ts";
// #819 — the cap helper below is typed on the gate's verdict shape.
import type { PlanSpecMismatch } from "./work-driver-plan-spec-coverage.ts";
import { planCorrectiveFailureEvent, planCorrectivePrompt } from "./work-driver-plan-timeout.ts";
import { planFindingsCount } from "./work-driver-pr-body-definition.ts";
import { inlinePlanPrompt } from "./work-driver-prompts-early.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import type { PlanUnfenceSummary } from "./workflow-state-schema.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

// #1263 test seam — module-level plan-step throw injection (offline tests
// only). A closure rather than an env var: env seams leak into hostile
// environments. Production never sets it.
let planThrowForTest: (() => void) | undefined;
export function setPlanThrowForTestForTest(fn: (() => void) | undefined): void {
  planThrowForTest = fn;
}

/**
 * Step 2 — Plan / decompose into workstreams (prompt: `pi-prompts/plan.md`).
 *
 * Parallelism is the default: up to 10 slots for multi-workstream issues.
 * The subagent reads the cached issue body + explore report, decides whether
 * the issue is 1, 2, or N+ independent workstreams, and reports each one with a
 * `report_workstream` tool call (#1652). N=1 is the same path (one `default`
 * call, so downstream iterates `Object.keys(workstreams)` uniformly).
 *
 * Failure modes: dispatch fails → halt (`dispatch-failed`); no accepted call →
 * one corrective, then park (`plan-spec-mismatch`). The corrective paths (#754's
 * kill recovery and the quality re-dispatch) END the step on their own failure
 * event, and a plan the #819 spec gate refuses ends on a `cap-hit` — neither
 * reaches the tail that writes `workstreams`.
 */
export async function runPlan(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // #1263 test seam — a module-level injection (set by offline tests via
  // setPlanThrowForTestForTest) that makes the plan step THROW from its own
  // code (not a dispatch failure runPlan catches) so the driver's catch path
  // is exercised. Production never sets it; closures, not env vars.
  planThrowForTest?.();
  let next = appendEvent(
    {
      ...state,
      pipelineState: { ...state.pipelineState, currentStep: "plan" },
    },
    { kind: "step-started", step: "plan", at: now },
  );
  const issues = activeIssuesOf(state);
  // #1652 — the plan's workstreams arrive as tool calls, so the companion must
  // be on disk before the child is spawned without it. A missing file is a
  // named failure here, not a plan that quietly reports nothing.
  const reporterMissing = await checkWorkstreamReporter();
  if (reporterMissing) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "plan",
      role: "explore",
      jobId: "unknown",
      label: "plan",
      ms: 0,
      at: Date.now(),
      exitCode: null,
      errorTail: reporterMissing,
    });
  }
  const { dispatch, section } = await issueImagesFor(ctx, issues, "plan");
  const startedAt = Date.now();
  // #1322 — an issue naming an existing commit/PR to port plans as one workstream.
  const port = await portReferenceForCycle(next, issues, ctx.repoRoot);
  // #1642 — the child is told where its inputs are. The corrective prompts
  // inherit this text: planCorrectivePrompt wraps it.
  const prompt = `${inlinePlanPrompt(issues, scratchDir(ctx.repoRoot, ctx.issue), planPromptInputsOf(next, ctx.repoRoot))}${section}${portPlanSection(port)}`;
  // #573 — derive transcript path BEFORE beginDispatch so crash-resume can
  // locate the surviving session file. Single dispatch: seq=undefined.
  const planRunId = `plan:explore:${process.pid}:${startedAt}`;
  const planTranscript = transcriptPathFor("explore", planRunId);
  // #382 — write-ahead: persist the intent to dispatch BEFORE awaiting, so a
  // process death inside the dispatch window is visible on disk rather than
  // leaving the file at the previous step boundary still claiming `running`.
  const begun = await beginDispatch(
    ctx,
    next,
    "plan",
    "explore",
    "plan",
    startedAt,
    planTranscript,
  );
  next = begun.state;
  let result: DispatchResult;
  // #754 — the PRIMARY plan dispatch carries the step's own bound; the
  // corrective below deliberately does not (it is the recovery path).
  // #799 — onSlow collects into the driver's pending buffer; the step
  // boundary (routeStepOutcome) drains it — this step folds nothing.
  const primaryOpts = {
    label: "plan",
    timeoutMs: planDispatchTimeoutMs(),
    onSlow: slowRecorder(ctx.issue, "plan"),
    // #838 — the plan dispatch's deck row (via the shared deck option).
    deck: { ...driverDeckOpts(ctx.issue, "plan", "plan"), label: "plan" },
    // #1652 — the report_workstream companion (see work-driver-plan-calls.ts).
    extraArgs: PLAN_WORKSTREAM_EXTRA_ARGS,
  };
  try {
    result = await dispatch(ctx.host, { role: "explore", prompt }, primaryOpts);
  } catch (err) {
    return appendEvent(clearDispatch(next, begun.jobId), {
      kind: "dispatch-failed",
      step: "plan",
      role: "explore",
      jobId: begun.jobId,
      label: "plan",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }
  // #754 — a primary dispatch killed at the plan bound is routed to the
  // corrective re-dispatch below: a killed child has no structured output,
  // the reply would report no workstream calls. The cause is rewritten at the
  // call site (not resolveKillCause) so downstream sees it, not a timeout.
  let planKill: DispatchResult | undefined;
  const primary = planTimeoutKill(result, primaryOpts);
  if (primary) {
    result = primary;
    planKill = result;
  }
  // #1652 — the workstreams are the ACCEPTED report_workstream calls. Zero is
  // not a `default` any more: the quality tail's corrective asks for the calls.
  // A killed primary's calls are ignored (its recovery corrective is the plan).
  // A killed primary keeps its REFUSALS (what the planner got wrong is still
  // evidence) and drops its accepted calls.
  const readout = workstreamCallsOf(result);
  const primaryReport: WorkstreamReport = planKill
    ? { ...emptyWorkstreamReport(), refused: readout.refused }
    : readout;
  const event = await buildCompletionEvent(ctx, "plan", "explore", "plan", result);
  next = appendPlanDispatchOutcome(clearDispatch(next, begun.jobId), "plan", primaryReport, event);
  // #1652 — a non-kill failure (provider error, non-zero exit) is a failed
  // dispatch, not a silent planner: its completion event is the tail and the
  // step router halts on it. Judging it for zero calls would send a false steer.
  if (!result.ok && !planKill) return next;
  // #1652 — calls whose results never arrived cannot be judged either way: park.
  if (primaryReport.unreadable > 0) return planResultsUnreadableCap(next, primaryReport);
  // The plan this step judges. Two views of it, and only these two: `judged` is
  // the raw report (the primary's, or the recovery corrective's when a kill was
  // recovered); `workstreams` is that report's map AFTER normalisation, which is
  // assigned below from `judged` in one place per branch.
  let judged: WorkstreamReport = primaryReport;
  let workstreams: Record<string, Workstream> = judged.workstreams;
  // #1005 — the first plan's RAW workstreams (before the coupling merge),
  // held aside for the #849 dropped-edge check. The dropped-edge check
  // compares the first plan's RAW map (the depends-on edges as the planner
  // declared them) against the corrective's RAW map. A killed primary has no
  // raw map (its calls were dropped), so this is `{}` there, as before.
  const firstPlanRaw = primaryReport.workstreams;
  let redispatched = false;
  // #1167 (size split) — the #849/#1005 dropped-edge state (`droppedEdges` and the
  // corrective's RAW map) moved with the tail into work-driver-plan-quality-pass.ts,
  // which now owns the one-shot corrective and its edge comparison; it initialises
  // `correctiveRaw` to undefined and sets it when a corrective runs. `firstPlanRaw`
  // is still read here because it is the RAW map the tail's edge check compares.

  const spec = next.pipelineState.normalisedSpec;
  // #819 round-2 — one read of the knob for every gate site in this step (the
  // primary spec gate, the gate's own dispatch guard, the corrective's spec
  // gate and the recorded reason). Four separate calls to a function that
  // reads `process.env` allowed an operator flip mid-step to make the gate
  // fire at one site and not the next.
  const planGateEnabled = planQualityEnabled();
  // #1005 — the coupling merge is a NO-OP on a single-workstream plan; the gate
  // and the corrective steer reason about the POST-MERGE plan. Its rule-3 grep
  // needs a real executor (`ctx.verifyExecFn` is test-only, so `execp` — it
  // honours `opts.argv` via execFile) and a cwd: the merge runs at plan time,
  // before the branch step, so the grep runs in `repoRoot`.
  const planExecFn = ctx.verifyExecFn ?? execp;
  // #1322 — the port fold and the contract's derived depends-on edges run
  // first; a plan with neither takes exactly the pre-#1322 single pass.
  // #819 round-3 — the pass lives in work-driver-plan-coupling-pass.ts (the
  // §12 line cap on this file); same fold, same merge, same executor. `planExecFn`
  // stays a local so every call site (the primary plan, the kill-recovered
  // corrective and the quality corrective) shares the one test seam.
  // #1167 round-4 — the fold, the merge and the unfence are ONE call now
  // (`runPlanNormalisationPass`), which is what lets the kill-recovered path
  // below get the identical normalisation instead of a copy that drifts. Read
  // each state from its own argument: the three paths normalise the plan they
  // actually hold. The SUMMARY is threaded out of the kill branch by the
  // caller, which is the only place that knows which plan the cycle kept —
  // letting the tail's own pass overwrite it is exactly what round-3 added
  // (`if (correctiveUnfence.summary) unfence = …`) and the recovery path must
  // not lose it.
  let killUnfence: PlanUnfenceSummary | undefined;
  // #1167 round-5 — set when the kill branch has already run the normalisation
  // over the plan the cycle keeps. `planTimeoutCorrective` now REQUIRES the
  // normaliser (an optional one was the shape that let a caller quietly stop
  // normalising), and this flag is what stops the tail below from normalising
  // the SAME map a second time: the double call re-spawned every `git grep`
  // for nothing, and the second pass's summary overwrote the kill branch's in
  // `planQuality.unfence`, so the audit records of the pass that actually
  // shaped the plan were lost.
  let normalisedOnce = false;
  const runNormalisation = async (
    raw: typeof workstreams,
    state: WorkState,
  ): Promise<{
    workstreams: typeof workstreams;
    summary?: PlanUnfenceSummary;
  }> =>
    runPlanNormalisationPass(raw, state, {
      port,
      repoRoot: ctx.repoRoot,
      worktrees: state.pipelineState.worktrees,
      execFn: planExecFn,
    });
  // #792 — count only the deliverables that are expected to produce a diff.
  // A plan-time no-diff marker (settings toggle, operator action, manual
  // verification) cannot land in any diff, so it must not feed the
  // decomposition arithmetic — a 4-code deliverable plan plus one settings
  // toggle reads as 4, not 5 (the #786 phantom-under-decomposition shape).
  const findingsCount = spec ? planFindingsCount(spec) : await countFindingsForCycle(ctx, next);

  // #290 — deterministic plan-quality gate: an under-decomposed plan is the
  // dominant convergence failure (lantern #604: an 8.6s plan collapsed six
  // findings into ONE workstream; the developer sprawled 11 files, looped 17
  // builds, burned 10.5M tokens). Arithmetic, not judgment — asking the model
  // that just under-decomposed whether it decomposed well is worthless.
  // #378 counts DELIVERABLES from the resolved spec, not enumerated markdown:
  // countEnumeratedFindings saw only `## Acceptance criteria` checkboxes and
  // none of #287's five `**A.**`–`**E.**` deliverables, so a correct N=1 plan
  // re-dispatched essentially every time. #754 — a primary killed at the step's
  // own bound gets the one-shot corrective below (the kill-triggered half).
  if (planKill) {
    const recovered = await planTimeoutCorrective(
      ctx,
      ctx.host,
      dispatch,
      prompt,
      planKill,
      next,
      planCorrectivePrompt,
      // #1167 round-4 — the recovered plan is normalised exactly like the
      // primary's and the quality corrective's: fold, coupling merge, unfence.
      // Without it a plan recovered after a killed primary reached develop with
      // the planner's fences intact, and the develop gate parked on a file the
      // issue itself names — the #1020 shape, arriving by the recovery door.
      async (raw, state) => {
        const out = await runNormalisation(raw, state);
        killUnfence = out.summary;
        normalisedOnce = true;
        return out.workstreams;
      },
    );
    // #819 round-2 — adopt the state even when the corrective did not recover:
    // `planTimeoutCorrective` appends the corrective's own failure event (its
    // kill, or the synthesised one for a dispatch that THREW) to the state it
    // returns, and the pre-round-2 `if (recovered.ok)` discarded it. The step
    // then ended on a `step-completed` with no failure tail at all, so the
    // router saw a successful plan step and the cycle went to branch with
    // `workstreams: {}` — the #754 "ends on its dispatch-failed and the
    // router's plan-timeout cap halts to handoff" contract was never actually
    // met on this path. `next` is already this function's local, so the
    // assignment is safe on both branches; `workstreams` stays `{}` on failure,
    // which the empty-plan synthetic-default branch below then fills.
    next = recovered.state;
    workstreams = recovered.workstreams;
    redispatched = true;
    if (recovered.report) judged = recovered.report;
    // #819 round-3 — a corrective that was KILLED or whose dispatch THREW ends
    // the step HERE. Falling through was the defect: the gates below read
    // `result.text` (the KILLED PRIMARY's text), the claims check registered a
    // claim for a plan nobody made, and the synthetic `default` workstream was
    // written into `pipelineState.workstreams` — so a cycle whose only honest
    // tail is the corrective's `dispatch-failed` still advertised a workstream
    // for develop. `recovered.state` already carries that tail.
    if (!recovered.ok) return recovered.state;
    // #1652 — the recovery corrective's unreadable results park; they are not a zero.
    if (recovered.report && recovered.report.unreadable > 0) {
      return planResultsUnreadableCap(next, recovered.report);
    }
    // #1652 — the recovery corrective is the one-shot budget, so a corrective
    // with no accepted call leaves no plan: park, do not build a `default`.
    if (recovered.report && recovered.report.accepted === 0) {
      return planNoWorkstreamCallsCap(
        next,
        recovered.report,
        "this is the one-shot corrective plan after a killed primary — it was not re-dispatched and develop never ran",
      );
    }
  }
  // #1167 — the plan-time unfence runs AFTER the fold and the coupling merge
  // and before the quality gate below, so the gate judges the plan the driver
  // will actually develop (see `runPlanNormalisationPass` for why the order is
  // load-bearing). #1167 round-3 — its summary goes to the quality tail's
  // single `planQuality` write so the operator can see the pass ran, what it
  // removed and what it declined to do (notes used to go only to `trace()`).
  // #1167 round-5 — skipped when the kill branch already normalised (see
  // `normalisedOnce`).
  let normalisedSummary: PlanUnfenceSummary | undefined;
  if (!normalisedOnce) {
    const normalised = await runPlanNormalisationPass(judged.workstreams, next, {
      port,
      repoRoot: ctx.repoRoot,
      worktrees: next.pipelineState.worktrees,
      execFn: planExecFn,
    });
    workstreams = normalised.workstreams;
    normalisedSummary = normalised.summary;
  }
  // The kill branch's own pass is the record of the plan the cycle keeps; a
  // plan that never went through the recovery keeps its own summary.
  const unfenceSummary = killUnfence ?? normalisedSummary;
  // #290 — deterministic plan-quality gate (arithmetic, not judgment), the
  // #819 plan-to-spec gate, the one-shot corrective, the #849 dropped-edge
  // check, the #571 claims and the single planQuality write. #1167 (size split)
  // moved that tail to work-driver-plan-quality-pass.ts for the AGENTS.md §12
  // cap; behaviour is unchanged, and `dispatch`, `workstreamCallsOf` and the
  // deck/slow-recorder options are threaded in so the pass is the only place
  // the corrective is built.
  const tail = await runPlanQualityTail(
    ctx,
    {
      next,
      report: judged,
      workstreams,
      firstPlanRaw,
      findingsCount,
      spec,
      planGateEnabled,
      planKill: planKill !== undefined,
      redispatched,
      // #1167 round-3 — the primary plan's unfence record, persisted with the
      // rest of the plan step's evidence. The corrective's own pass overwrites
      // it (that is the plan the cycle keeps).
      unfence: unfenceSummary,
    },
    {
      dispatch,
      prompt,
      couplingExecFn: planExecFn,
      slow: (issue: number, step: "plan") => slowRecorder(issue, step),
      deck: (issue: number, step: "plan", label: string) => ({
        ...driverDeckOpts(issue, step, label),
        label,
      }),
    },
  );
  if (tail.halted) return tail.state;
  next = tail.state;
  return {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      workstreams: tail.workstreams,
      planQuality: tail.planQuality,
    },
  };
}
