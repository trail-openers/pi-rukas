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
  countMarkdownSections,
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
import { runPlanCouplingPass } from "./work-driver-plan-coupling-pass.ts";
import { planSpecMismatchReason } from "./work-driver-plan-spec-coverage.ts";
import { execp } from "./work-driver-verify.ts";
// #679 — the CANONICAL planQualityReason / correctivePlanSteer / steer builders
// live in work-driver-plan-helpers.ts; this module re-exports them so existing
// importers (smoke tests, cross-module consumers) keep their paths. The stale
// duplicate copy that used to sit here was deleted — one function, one module.
export {
  correctivePlanSteer,
  correctiveTestSubjectSplitSteer,
  countEnumeratedFindings,
  countFindingsForCycle,
  findDroppedDependencyEdges,
  planQualityEnabled,
  planQualityReason,
  planCorrectivePrompt,
  planDispatchTimeoutMs,
  planTimeoutCorrective,
} from "./work-driver-plan-helpers.ts";
export { maxWorkstreams, parseWorkstreams } from "./work-driver-plan-workstreams.ts";
export {
  type ExploreVerdict,
  parseExploreVerdict,
  parsePerIssueVerdicts,
} from "./work-driver-plan-verdicts.ts";
export {
  findUncoveredDeliverables,
  planSpecMismatchReason,
} from "./work-driver-plan-spec-coverage.ts";
// #819 round-3 — the gate's HALT is now reachable from `runPlan`'s own tail (the
// backstop under the `primaryGateRefused` assertion), so a caller that reads the
// gate's verdict must be able to read the halt it produces from the same module.
export { planSpecMismatchCap } from "./work-driver-plan-helpers.ts";
import {
  correctivePlanSteer,
  correctiveTestSubjectSplitSteer,
  countFindingsForCycle,
  findDroppedDependencyEdges,
  planDispatchTimeoutMs,
  planQualityEnabled,
  planQualityReason,
  planSpecMismatchCap,
  planTimeoutCorrective,
  planTimeoutKill,
} from "./work-driver-plan-helpers.ts";
import { findPathCollisions, findTestSubjectSplits } from "./work-driver-plan-paths.ts";
// #819 — the cap helper below is typed on the gate's verdict shape.
import type { PlanSpecMismatch } from "./work-driver-plan-spec-coverage.ts";
import { planCorrectiveFailureEvent, planCorrectivePrompt } from "./work-driver-plan-timeout.ts";
import { parseWorkstreams } from "./work-driver-plan-workstreams.ts";
import { planFindingsCount } from "./work-driver-pr-body-definition.ts";
import { inlinePlanPrompt } from "./work-driver-prompts-early.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
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
 * the issue is 1, 2, or N+ independent workstreams, and returns a fenced
 * `## Workstreams` block. N=1 is the same path (a `default` workstream is
 * always written so downstream iterates `Object.keys(workstreams)` uniformly).
 *
 * Failure modes: 0 workstreams → synthetic `default`; dispatch fails → halt
 * (`dispatch-failed`). Both corrective paths (#754's kill recovery and #290's
 * quality re-dispatch) END the step on their own failure event, and a plan the
 * #819 spec gate refuses ends on a `cap-hit` — neither reaches the tail that
 * writes `workstreams`.
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
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "plan" } },
    { kind: "step-started", step: "plan", at: now },
  );
  const issues = activeIssuesOf(state);
  const { dispatch, section } = await issueImagesFor(ctx, issues, "plan");
  const startedAt = Date.now();
  // #1322 — an issue naming an existing commit/PR to port plans as one workstream.
  const port = await portReferenceForCycle(next, issues);
  const prompt = `${inlinePlanPrompt(issues, scratchDir(ctx.repoRoot, ctx.issue))}${section}${portPlanSection(port)}`;
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
  // parseWorkstreams would return nothing. The cause is rewritten at the
  // call site (not resolveKillCause) so downstream sees it, not a timeout.
  let planKill: DispatchResult | undefined;
  const primary = planTimeoutKill(result, primaryOpts);
  if (primary) {
    result = primary;
    planKill = result;
  }
  const event = await buildCompletionEvent(ctx, "plan", "explore", "plan", result);
  next = appendEvent(clearDispatch(next, begun.jobId), event);
  // Parse workstreams out of the reply. Failure or N=0 collapses to
  // `default` — never blocks the cycle.
  let workstreams = parseWorkstreams(result.text ?? "");
  // #1005 — the first plan's RAW workstreams (before the coupling merge),
  // held aside for the #849 dropped-edge check. The dropped-edge check
  // compares the first plan's RAW map (the depends-on edges as the planner
  // declared them) against the corrective's RAW map.
  const firstPlanRaw = workstreams;
  let redispatched = false;
  // #849/#1005 — held for the dropped-edge check. Set ONLY when the quality
  // gate fires on the primary's plan: the kill-triggered corrective is a
  // recovery path with no parsed first plan to compare against, and a partial
  // parse of a killed primary is not a legitimate comparison target (the
  // pre-#1005 defect: it was set at declaration, so the kill path fed the
  // check a map that was never a real first plan).
  let firstPlanWorkstreams: typeof workstreams | undefined;
  // #1005 — the corrective's RAW workstreams (before its own coupling
  // merge), held aside for the #849 dropped-edge check.
  let correctiveRawWorkstreams: typeof workstreams | undefined;
  let droppedEdges: { from: string; to: string }[] | undefined;

  const spec = next.pipelineState.normalisedSpec;
  // #819 round-2 — one read of the knob for every gate site in this step (the
  // primary spec gate, the gate's own dispatch guard, the corrective's spec
  // gate and the recorded reason). Four separate calls to a function that
  // reads `process.env` allowed an operator flip mid-step to make the gate
  // fire at one site and not the next.
  const planGateEnabled = planQualityEnabled();
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
      parseWorkstreams,
      planCorrectivePrompt,
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
    // #819 round-3 — a corrective that was KILLED or whose dispatch THREW ends
    // the step HERE. Falling through was the defect: the gates below read
    // `result.text` (the KILLED PRIMARY's text), the claims check registered a
    // claim for a plan nobody made, and the synthetic `default` workstream was
    // written into `pipelineState.workstreams` — so a cycle whose only honest
    // tail is the corrective's `dispatch-failed` still advertised a workstream
    // for develop. `recovered.state` already carries that tail.
    if (!recovered.ok) return recovered.state;
  }
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
  // stays a local so both call sites (the primary plan and the corrective) share
  // the one test seam.
  const runCouplingMerge = async (raw: typeof workstreams): Promise<typeof workstreams> =>
    runPlanCouplingPass(raw, {
      port,
      repoRoot: ctx.repoRoot,
      worktrees: next.pipelineState.worktrees,
      execFn: planExecFn,
    });
  workstreams = await runCouplingMerge(workstreams);
  // #290 — deterministic plan-quality gate (arithmetic, not judgment).
  // #378 — count DELIVERABLES from the resolved spec, not enumerated markdown.
  const reason = planQualityReason(workstreams, findingsCount);
  // #819 — the plan-to-spec gate, immediately after `planQualityReason` and
  // before `checkAndRegisterClaims`: pure over (reply text, workstreams, spec),
  // no dispatch, no I/O. It reads the reply's RAW text because the multi-block
  // defect is invisible in the parsed map. An existing shape reason takes
  // precedence in the steer: a collision is a fixable split, wrong work is not.
  const specMismatch = planGateEnabled
    ? planSpecMismatchReason(result.text ?? "", workstreams, spec)
    : undefined;
  // #819 round-3 — a primary refusal is never silently outlived. Every earlier
  // path that judges it returns, except one: the shape gate fired too, the
  // corrective ran, and the corrective's OWN text passed the gate — the tail
  // would otherwise record `under-decomposed` and hand develop a plan the spec
  // gate called wrong. So the tail halts on any unresolved refusal; "unresolved"
  // means no corrective ran for it (a refused corrective caps at its own site).
  const primaryGateRefused = planGateEnabled && specMismatch !== undefined && !redispatched;
  // The kill-triggered corrective already spent this cycle's one-shot budget,
  // so the gate below does not re-dispatch — but #819 must not develop on a
  // plan nobody checked: halt with the same cap a wrong corrective gets.
  if (planKill && specMismatch) {
    return planSpecMismatchCap(
      next,
      specMismatch,
      "the one-shot plan corrective was already spent on the killed primary plan, so this plan was not re-dispatched",
    );
  }
  // #754 — the kill-triggered corrective already spent the one-shot budget;
  // the gate below must not spend it twice. #819 — a spec mismatch fires the
  // same one-shot corrective; when only the spec gate fired the steer is the
  // spec-steer (an existing reason keeps precedence: more specific diagnosis).
  if (!planKill && planGateEnabled && (reason || specMismatch)) {
    // #849 — the first plan's RAW workstreams, held aside for the dropped-edge
    // check. Set here (the quality gate firing on the primary's plan) so the
    // kill-triggered corrective path leaves it undefined (pre-#1005 shape).
    // The RAW map (before the coupling merge) is what the dropped-edge check
    // needs: it compares the first plan's declared depends-on edges against
    // the corrective's declared edges.
    firstPlanWorkstreams = firstPlanRaw;
    trace(
      `work-driver: plan quality — ${reason ?? specMismatch?.kind}, re-dispatching once${
        reason && specMismatch ? ` (also plan-spec-mismatch: ${specMismatch.kind})` : ""
      }`,
    );
    const steer =
      reason === "test-subject-split"
        ? correctiveTestSubjectSplitSteer(findTestSubjectSplits(workstreams))
        : correctivePlanSteer(
            reason ?? "plan-spec-mismatch",
            findingsCount,
            Object.keys(workstreams).length,
            findPathCollisions(workstreams),
          );
    // #657 post-mortem — the corrective inherits the original prompt plus any
    // prior-handoff context; a weak model read a stale `cross-group-conflict`
    // as a live unsatisfiable precondition and burned 73.5M cache tokens
    // re-verifying it before the wall-clock kill — twice.
    const correctivePrompt = planCorrectivePrompt(prompt, steer);
    const retry = await dispatch(
      ctx.host,
      { role: "explore", prompt: correctivePrompt },
      {
        label: "plan:corrective",
        onSlow: slowRecorder(ctx.issue, "plan"),
        deck: { ...driverDeckOpts(ctx.issue, "plan", "plan:corrective"), label: "plan:corrective" },
      },
    ).catch(() => undefined);
    // #819 round-3 — a corrective whose dispatch THREW is a failure of the step,
    // not an absence of one. The pre-round-3 `if (retry)` skipped the whole
    // block on a rejection, so the step fell through to the tail, recorded the
    // PRIMARY's completion, kept its defective workstreams and claimed them:
    // the router saw a clean plan and walked into branch.
    if (!retry) {
      return appendEvent(next, {
        kind: "dispatch-failed",
        step: "plan",
        role: "explore",
        jobId: "unknown",
        label: "plan:corrective",
        ms: 0,
        at: Date.now(),
        exitCode: null,
        errorTail: "[pi-rukas] the one-shot corrective plan dispatch threw and produced no result",
      });
    }
    {
      // #819 round-3 — the kill check runs BEFORE any append and the step
      // returns right after, so a killed corrective gets exactly ONE
      // `dispatch-failed`. Pre-round-3 the same result went through
      // `buildCompletionEvent` (which turns any `killCause` into its own
      // `dispatch-failed`) AND `planKillFailureEvent`, appending two failure
      // events for one kill — two competing tails for the same step.
      // #754 — the corrective is NEVER re-dispatched again — exactly one
      // corrective re-dispatch per cycle, whether the trigger was plan-quality
      // findings or the #754 kill above. If it too failed or was killed, the
      // step ends on its dispatch-failed and the router's `plan-timeout` cap
      // halts to handoff.
      if (retry.killCause) {
        return appendEvent(next, await planCorrectiveFailureEvent(ctx, "plan:corrective", retry));
      }
      next = appendEvent(
        next,
        await buildCompletionEvent(ctx, "plan", "explore", "plan:corrective", retry),
      );
      const reparsed = parseWorkstreams(retry.text ?? "");
      // Second result is final — including when it is no better. One retry,
      // never a loop; a plan step that can re-dispatch on its own verdict is
      // a plan step that can spin.
      if (Object.keys(reparsed).length > 0) {
        workstreams = reparsed;
        correctiveRawWorkstreams = reparsed; // #1005 — the corrective's RAW map
      }
      redispatched = true;
      // #1005 — the coupling merge runs AGAIN on the corrective's plan: it may
      // merge the colliding workstreams (the overlap fix) but may also re-split
      // coupled work, so it must see the corrective's map, not just the first
      // plan's. Cheap: a depends-on edge short-circuits the grep.
      workstreams = await runCouplingMerge(workstreams);
      // #819 — the gate runs AGAIN on the corrective: #818's wrong work came
      // from the corrective, not the first plan. A corrective is already the
      // cycle's one-shot budget, so a failure here HALTS.
      const correctiveMismatch = planGateEnabled
        ? planSpecMismatchReason(retry.text ?? "", workstreams, spec)
        : undefined;
      if (correctiveMismatch) {
        return planSpecMismatchCap(
          next,
          correctiveMismatch,
          "this is the one-shot corrective plan — it was not re-dispatched and develop never ran",
        );
      }
    }
  }
  // #849 — the one-shot corrective re-plan is free to MERGE the colliding
  // workstreams (the overlap fix) but not to silently drop a dependsOn edge
  // the first plan had. The match is id-priority with a path-set signature
  // fallback for renamed workstreams; a merged pair never flags. See
  // findDroppedDependencyEdges for the full rule. `firstPlanWorkstreams` is
  // set only when the quality gate fired on the PRIMARY's plan (#1005), and
  // the comparison is against the corrective's RAW map — `workstreams` is by
  // now the POST-MERGE map, so the RAW one is what the edge check needs.
  if (firstPlanWorkstreams && redispatched) {
    const dropped = findDroppedDependencyEdges(
      firstPlanWorkstreams,
      correctiveRawWorkstreams ?? workstreams,
    );
    if (dropped.length > 0) {
      droppedEdges = dropped;
      trace(
        `work-driver: plan quality — corrective dropped ${dropped.length} dependsOn edge(s) without merging: ${dropped.map((e) => `${e.from}→${e.to}`).join(", ")}`,
      );
    }
  }

  // #571 — cross-group claim check: detect sibling overlaps BEFORE registering.
  // Parking early costs one plan dispatch, not a full develop-to-commit burn.
  if (crossGroupConflictsEnabled()) {
    next = await checkAndRegisterClaims(ctx, next, workstreams);
  }
  if (Object.keys(workstreams).length === 0) {
    workstreams.default = {
      id: "default",
      scope: `Issue #${ctx.issue}`,
      paths: [],
      outOfScope: [],
    };
    workstreams = foldPortPlan(workstreams, port); // #1322 — a port keeps its scope
  }
  // #849 — planQuality is written EXACTLY ONCE here: the final reason is
  // computed once (`dropped-dependencies` wins when the corrective dropped an
  // edge, else the first plan's quality reason) so the mid-function #849
  // check and the return can no longer disagree.
  //
  // #819 round-3 — a reason a halt path already persisted survives this write
  // (it is the fallback of `finalReason` below) and trips the assertion under
  // it: the field's whole purpose is that `lastCapHit` is not the only reader
  // of the verdict, so a halted cycle never loses it to the tail's object.
  const haltReason = next.pipelineState.planQuality?.reason;
  if (haltReason === "plan-spec-mismatch") {
    throw new Error(
      "work-driver: runPlan reached its final return with planQuality.reason = plan-spec-mismatch — the plan-to-spec halt must return before the gates, the claims and the synthetic default workstream",
    );
  }
  // The primary's refusal has no earlier `return` when the corrective ran and
  // was judged on its OWN text (a corrective whose paths cover the spec leaves
  // `correctiveMismatch` silent). Whatever the shape gate concluded, the cycle
  // must not reach develop on a plan the spec gate refused: the tail halts.
  if (primaryGateRefused) {
    return planSpecMismatchCap(
      next,
      specMismatch as PlanSpecMismatch,
      "the primary plan carried a shape the plan-to-spec gate refuses, and no corrective plan replaced it",
    );
  }
  const finalReason =
    droppedEdges && droppedEdges.length > 0 ? "dropped-dependencies" : (reason ?? haltReason);
  return {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      workstreams,
      planQuality: {
        findingsCount,
        redispatched,
        ...(finalReason ? { reason: finalReason } : {}),
        ...(droppedEdges ? { droppedEdges } : {}),
      },
    },
  };
}
