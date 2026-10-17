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
import { runPlanCouplingPass, runPlanUnfencePass } from "./work-driver-plan-coupling-pass.ts";
import { runPlanQualityTail } from "./work-driver-plan-quality-pass.ts";
import { planSpecMismatchReason } from "./work-driver-plan-spec-coverage.ts";
import { execp } from "./work-driver-verify.ts";
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
// #1167 (size split) — the corrective steers moved to work-driver-plan-steers.ts
// so this step handler stays inside the §12 cap; the re-export keeps every
// existing importer's path working, which is the whole reason they live here.
export { correctivePlanSteer, correctiveTestSubjectSplitSteer } from "./work-driver-plan-steers.ts";
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
import {
  findFenceContradictions,
  findPathCollisions,
  findTestSubjectSplits,
} from "./work-driver-plan-paths.ts";
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
  // dominant convergence failure (nessie #604: an 8.6s plan collapsed six
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
  // #1167 — the plan-time unfence, after the fold and the coupling merge and
  // before the quality gate below, so the gate judges the plan the driver will
  // actually develop (see runPlanUnfencePass for why the order is load-bearing).
  workstreams = await runPlanUnfencePass(workstreams, next, {
    repoRoot: ctx.repoRoot,
    execFn: planExecFn,
  });
  // #290 — deterministic plan-quality gate (arithmetic, not judgment), the
  // #819 plan-to-spec gate, the one-shot corrective, the #849 dropped-edge
  // check, the #571 claims and the single planQuality write. #1167 (size split)
  // moved that tail to work-driver-plan-quality-pass.ts for the AGENTS.md §12
  // cap; behaviour is unchanged, and `dispatch`, `parseWorkstreams` and the
  // deck/slow-recorder options are threaded in so the pass is the only place
  // the corrective is built.
  const tail = await runPlanQualityTail(
    ctx,
    {
      next,
      text: result.text ?? "",
      workstreams,
      firstPlanRaw,
      findingsCount,
      spec,
      planGateEnabled,
      planKill: planKill !== undefined,
      redispatched,
      correctiveRaw: correctiveRawWorkstreams,
      port,
    },
    {
      dispatch,
      prompt,
      parseWorkstreams,
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
