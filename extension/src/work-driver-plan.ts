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
  mergeWithContract,
  portPlanSection,
  portReferenceForCycle,
} from "./work-driver-plan-contract.ts";
import { mergeCoupledWorkstreams } from "./work-driver-plan-coupling.ts";
// #819 round-2 — `countMarkdownSections` has exactly ONE definition (the parse
// module's). The spec-coverage module used to carry a second copy, which is a
// drift hazard rather than a convenience, so it now imports the counter and
// this module re-exports it from the parse module only.
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
// #849 — parseWorkstreams + maxWorkstreams moved to work-driver-plan-workstreams.ts
export { maxWorkstreams, parseWorkstreams } from "./work-driver-plan-workstreams.ts";
// The explore-reply verdict parsers moved to work-driver-plan-verdicts.ts for
// the §12 line cap; re-exported so their importers keep this module's path.
export {
  type ExploreVerdict,
  parseExploreVerdict,
  parsePerIssueVerdicts,
} from "./work-driver-plan-verdicts.ts";
// #819 — the plan-to-spec gate's pieces, re-exported so the smoke tests import
// the gate from the plan module the same way they import every other rule.
export {
  findUncoveredDeliverables,
  planSpecMismatchReason,
} from "./work-driver-plan-spec-coverage.ts";
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
import { planCorrectivePrompt, planKillFailureEvent } from "./work-driver-plan-timeout.ts";
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
 * (`dispatch-failed`).
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
  // #849/#1005 — the first plan's workstreams (and their dependsOn edges),
  // held aside for the dropped-edge check. Set ONLY when the quality gate
  // fires on the primary's plan (the #849 pre-#1005 shape): the
  // kill-triggered corrective is a recovery path with no parsed first plan
  // to compare against (the primary was killed mid-stream and produced no
  // structured output), so there is nothing its re-plan could have dropped.
  // A partial parse of the killed primary (the pre-#1005 defect: the
  // variable was set to `firstPlanRaw` at declaration, so the kill path
  // fed the #849 check a map that was never a real first plan) is not a
  // legitimate comparison target and is not passed to it.
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

  // #290 — deterministic plan-quality gate. An under-decomposed plan is the
  // dominant convergence failure: on nessie #604 an 8.6s plan collapsed six
  // enumerated findings into ONE workstream, the developer then sprawled
  // across 11 files, looped 17 failed builds and burned 10.5M tokens before
  // dying. The check is arithmetic, not judgment — asking the model that just
  // under-decomposed whether it decomposed well is worthless.
  // #378 — count DELIVERABLES from the resolved spec, not enumerated markdown.
  // countEnumeratedFindings counts top-level `- [ ]`, and in a /plan-authored
  // issue checkboxes are exclusive to `## Acceptance criteria` — so it was
  // counting test assertions. Measured on real issues: #287→7, #288→6,
  // #289→7, #366→6, with ZERO of #287's five actual deliverables (`**A.**`–
  // `**E.**`) seen, because bolded letters are invisible to it. A correctly
  // planned single-workstream issue therefore triggered a corrective
  // re-dispatch essentially every time.
  // #754 — a primary killed at the step's own bound gets the one-shot
  // corrective re-dispatch below (the kill-triggered half of it).
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
  }
  // #1005 — the coupling merge is a NO-OP on a single-workstream plan; the
  // gate and the corrective steer reason about the POST-MERGE plan.
  // #1005 — the coupling merge's rule-3 grep (argv form) needs a real
  // executor: `ctx.verifyExecFn` is test-only, so fall back to `execp`
  // (honours `opts.argv` via execFile). The merge runs at plan time, before
  // the branch step, so the grep runs in `repoRoot` (the 4th arg) — the
  // empty pre-branch worktrees map alone left rule 3 without a cwd.
  const planExecFn = ctx.verifyExecFn ?? execp;
  // #1322 — the port fold and the contract's derived depends-on edges run
  // first; a plan with neither takes exactly the pre-#1322 single pass.
  const runCouplingMerge = async (raw: typeof workstreams): Promise<typeof workstreams> => {
    const ws = foldPortPlan(raw, port);
    if (Object.keys(ws).length <= 1) return ws;
    const coupling = await mergeWithContract(ws, (w) =>
      mergeCoupledWorkstreams(w, planExecFn, next.pipelineState.worktrees, ctx.repoRoot),
    );
    if (coupling.changed) {
      for (const m of coupling.merges) {
        trace(`work-driver: plan coupling merge — ${m.from} → ${m.into} (${m.reason})`);
      }
      return coupling.workstreams;
    }
    return ws;
  };
  workstreams = await runCouplingMerge(workstreams);
  // #290 — deterministic plan-quality gate (arithmetic, not judgment).
  // #378 — count DELIVERABLES from the resolved spec, not enumerated markdown.
  const reason = planQualityReason(workstreams, findingsCount);
  // #819 — the plan-to-spec gate, immediately after `planQualityReason` and
  // before `checkAndRegisterClaims`: a pure function of (reply text,
  // workstreams, spec), no dispatch, no I/O. It reads the reply's RAW text
  // because the multi-block defect is invisible in the parsed map — the parser
  // saw one block and produced one map either way.
  // An existing reason takes precedence in the corrective steer (the more
  // specific diagnosis: a collision is a fixable split, wrong work is not).
  const specMismatch = planGateEnabled
    ? planSpecMismatchReason(result.text ?? "", workstreams, spec)
    : undefined;
  // The kill-triggered corrective already spent this cycle's one-shot budget,
  // so the gate below does not re-dispatch — but #819 must not proceed to
  // develop on a plan nobody checked: it halts with the same cap a wrong
  // corrective gets, and the evidence says the corrective could not run.
  if (planKill && specMismatch) {
    return planSpecMismatchCap(
      next,
      specMismatch,
      "the one-shot plan corrective was already spent on the killed primary plan, so this plan was not re-dispatched",
    );
  }
  // #754 — the kill-triggered corrective already spent this cycle's one-shot
  // corrective budget; the quality gate below must not spend it a second time.
  // #819 — a plan-to-spec mismatch fires the same one-shot corrective; when
  // the shape gate passed and only the spec gate fired, the steer is the
  // spec-steer (an existing reason keeps precedence: it is the more specific
  // diagnosis of the two).
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
    // #657 post-mortem — the corrective re-dispatch inherits the original
    // prompt plus any prior-handoff / prior-conflict context the cycle has
    // accumulated. A weak model read a stale `cross-group-conflict` (issue
    // already closed, fix already on base) as a LIVE unsatisfiable
    // precondition, re-verified it with two gh/git commands 530+ times, and
    // burned 73.5M cache tokens before the wall-clock kill — twice.
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
    if (retry) {
      // #754 — the corrective is NEVER re-dispatched again — exactly one
      // corrective re-dispatch per cycle, whether the trigger was plan-quality
      // findings or the #754 kill above. If it too failed or was killed, the
      // step ends on its dispatch-failed and the router's `plan-timeout` cap
      // halts to handoff.
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
      // #819 round-2 — a corrective killed by one of the driver's own caps
      // (backstop timeout, loop detector, token budget, abort) is NOT a plan:
      // a killed child has no structured output, so judging its text against
      // the spec gate invents a `plan-spec-mismatch` finding out of a silence
      // we caused. Route it like the primary's kill instead — a `dispatch-failed`
      // carrying the structured cause, whose tail the step router maps to the
      // plan caps (`plan-timeout` for the step's own bound, the cap's own
      // literal for loop/token-budget, else `step-failed:plan`).
      if (retry.killCause) {
        return appendEvent(next, planKillFailureEvent("plan", "explore", "plan:corrective", retry));
      }
      // #1005 — the coupling merge runs AGAIN on the corrective plan: the
      // corrective re-plan is free to merge the colliding workstreams (that
      // is the overlap fix), but it is also free to split coupled work AGAIN
      // (re-splitting the pair the first merge joined, or introducing a new
      // depends-on edge between previously-disjoint halves). The merge must
      // see the corrective's workstreams, not just the first plan's. Cheap:
      // a depends-on edge (rule 2) short-circuits the grep, so the common
      // re-split shape costs no exec calls.
      workstreams = await runCouplingMerge(workstreams);
      // #819 — the gate runs AGAIN on the corrective: the #818 incident's
      // wrong work came from the CORRECTIVE, not the first plan, so checking
      // only before the re-dispatch would have passed it. A corrective is
      // already this cycle's one-shot budget — a plan-to-spec failure here
      // HALTS rather than proceeding to branch/develop on fabricated scope.
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
  // fallback for renamed workstreams; a merged pair never flags.
  // See findDroppedDependencyEdges for the full rule.
  if (firstPlanWorkstreams && redispatched) {
    // #1005 — the dropped-edge check compares the FIRST plan's RAW
    // workstreams (held aside before the coupling merge) against the
    // corrective's RAW workstreams. The corrective's own coupling merge
    // (in the re-dispatch block above) has already run, so `workstreams` is
    // the POST-MERGE map; the corrective's RAW map is needed for the edge
    // check. Use the corrective's parsed workstreams (before its merge).
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

  // #571 — cross-group claim check. Detect path overlaps with sibling cycles
  // BEFORE registering. Parking early costs one plan dispatch, not a full
  // develop/adversarial/commit-pr burn. Extracted to a helper (line budget).
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
  const finalReason =
    droppedEdges && droppedEdges.length > 0
      ? "dropped-dependencies"
      : (reason ?? (specMismatch && planGateEnabled ? ("plan-spec-mismatch" as const) : undefined));
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
