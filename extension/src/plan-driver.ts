/**
 * plan-driver — the compiled five-phase /plan pipeline (orchestrator).
 *
 * A compiled driver PM calls, not a prose flow PM re-implements. The
 * mode-independent issue-creation guard (issue-creation-guard.ts) makes
 * the replacement safe: direct `gh issue create` bash is refused for
 * every role in every mode.
 * Phase compilation (each phase's detail lives in its module's header):
 *   0  Classify [plan-types.ts] · 0b Precheck [plan-precheck.ts]
 *   1  Inventory — vipune + `gh issue list`, driver-run [plan-draft.ts]
 *   1b+2 Investigate — duplicate-risk + angles as ONE parallel barrier
 *      [plan-investigate.ts] — includes the #677 NEVER CLAIM post-filter
 *   3  Draft [plan-draft.ts] · 3b Validate [plan-validate.ts]
 *   4  Gap gate — CRITICAL-only terminal rule [plan-gaps.ts]
 *   5  File — forge issueCreate [plan-filing.ts]
 *
 * dryRun is the confirmation seam: `dryRun: true` returns the spec +
 * gaps without filing; on confirmation the driver is re-called without
 * dryRun. Every phase is timed (PlanResult.timings — measure, then cut).
 * #1043: an identical confirm of a FILEABLE dry run files its reviewed spec
 * verbatim (plan-confirm.ts — no phase below runs).
 * #1541: the run is cancellable — the async job's AbortSignal reaches every
 * phase boundary (plan-driver-cancel.ts), every child dispatch, and each round
 * of the gap gate. Per-phase seams live in their own `plan-driver-*.ts` module.
 */

import { dispatchCore } from "./dispatch.ts";
import { type PlanBase, withPlanBase } from "./plan-base-tree.ts";
import { confirmVerbatim, heldForReview, settlePlanCache } from "./plan-confirm.ts";
import { codeIdentifiersIn, mechanicalInventory } from "./plan-draft.ts";
import { cacheLineage, openRunCache } from "./plan-driver-cache.ts";
import { cancelledResult } from "./plan-driver-cancel.ts";
import { assembleFinalBody } from "./plan-driver-final-body.ts";
import { gapGateApplies, phase4GapGate } from "./plan-driver-gate.ts";
import { allAnglesFailedHalt, haltResult, phaseTimer } from "./plan-driver-halt.ts";
import { phase3Draft } from "./plan-driver-phase3.ts";
import {
  correctiveRedraftHalt,
  duplicateRiskHalt,
  needsClarificationHalt,
} from "./plan-driver-phases.ts";
import { correctiveRedraft } from "./plan-driver-redraft.ts";
import { buildFinalPlanResult } from "./plan-driver-result.ts";
import {
  type PlanDispatchFn,
  getPlanDispatchOverride,
  getPlanStatFnOverride,
} from "./plan-driver-seams.ts";
import { validatePhase3Draft } from "./plan-driver-validate.ts";
import {
  compactedDisclosure,
  finalizeDroppedDisclosure,
  neverClaimDisclosureSection,
  tracePlanRun,
} from "./plan-dropped-artifact.ts";
import { loadPlanImages, planImageLinksSection, withPlanImages } from "./plan-images.ts";
import {
  type InvestigationResult,
  PLAN_DISPATCH_TIMEOUT_MS,
  PLAN_MARKER_CHILD_ARGS,
  runInvestigation,
} from "./plan-investigate.ts";
import { readInvestigationCache } from "./plan-investigation-cache.ts";
import { phase5FilingFailure } from "./plan-phase5.ts";
import { precheckDescriptor } from "./plan-precheck.ts";
import { assemblePriorContext } from "./plan-prior-context-assembly.ts";
import { withProvenance } from "./plan-provenance.ts";
import { type PlanTarget, planTargetFacts } from "./plan-target.ts";
import {
  type PlanDriverInput,
  type PlanGap,
  type PlanResult,
  classifyPlanType,
  planTitle,
} from "./plan-types.ts";
import { FORGE_BODY_MAX, parsePinnedSubIssueCount } from "./plan-validate.ts";
import { trace } from "./trace.ts";
import type { DriverHost } from "./work-driver-host.ts";

// Phase-4 prompts (round-1 review + round-2 scoped verification) live in
// plan-gate-prompt.ts; re-exported here for the existing consumers.
export { gapGatePrompt } from "./plan-gate-prompt.ts";

// ---------------------------------------------------------------------------
// runPlanPipeline
// ---------------------------------------------------------------------------

/** Options of {@link runPlanPipeline}. */
export interface PlanPipelineOptions {
  /**
   * #1541 review (MEDIUM) — the tool path passes the async-job's own signal, so
   * dispatch_kill / session shutdown stop the run. Omitted: the run cannot be killed.
   */
  signal?: AbortSignal;
  /**
   * #1854: the repository this run files into, resolved by the tool BEFORE it
   * launched the job (`plan-target.ts`). Absent → the `repoRoot` argument, the
   * session repository (the pre-#1854 behaviour). Supplied, every consumer keys off
   * the TARGET: the base tree the children read, the cache lineage, the inventory's
   * forge, the label gate, the create call and the dropped artifact. A property of
   * the options rather than a fifth positional argument, so the signal stays in the
   * call's object position where the kill-path canary reads it.
   */
  target?: PlanTarget;
}

export async function runPlanPipeline(
  pi: DriverHost,
  input: PlanDriverInput,
  repoRoot: string,
  opts: PlanPipelineOptions = {},
): Promise<PlanResult> {
  const root = opts.target?.repoRoot ?? repoRoot;
  // #1132: one origin fetch per run; the base tree is removed when the run ends.
  return withPlanBase(root, async (base) => {
    const result = await runPipelineOn(pi, input, root, base, opts);
    return base.baseFallback ? { ...result, baseFallback: base.baseFallback } : result;
  });
}

/**
 * The run body. The cancellation halt lives in plan-driver-cancel.ts and is
 * checked at every phase boundary below, plus per-round in the gap gate.
 */
async function runPipelineOn(
  pi: DriverHost,
  input: PlanDriverInput,
  repoRoot: string,
  base: PlanBase,
  opts: PlanPipelineOptions,
): Promise<PlanResult> {
  const signal = opts.signal;
  // The source issue's images (plan-images.ts): with every child, links in the body.
  const images = await loadPlanImages();
  const dispatch = withPlanImages(images, getPlanDispatchOverride() ?? dispatchCore);
  const { descriptor, context, dryRun } = input;
  const type = classifyPlanType(descriptor, input.type);
  const depth = input.depth ?? 0;
  // #1854: the digest/lineage term for the destination, derived once by the
  // resolver's own companion (plan-target.ts).
  const targetIdentity = planTargetFacts(input.targetRepository, opts.target).targetIdentity;
  // Per-phase wall-clock record (research next-step #1: measure, then cut).
  const { timed, finishTimings } = phaseTimer();

  // #1043 — the cache lineage at the run's base (the whole protocol lives in
  // plan-driver-cache.ts). A dry run never READS the investigation cache (it is the
  // thing confirmed); it DROPS the lineage first, so a halting dry run leaves no
  // fileable verdict, and its settled gaps are read before the drop. #1132: "HEAD"
  // here is origin/<default>, not local HEAD; #1854: the target repository is part of
  // the lineage, so two repositories cannot read each other's cached barrier.
  const lineage = cacheLineage(input, descriptor, context, type, depth, targetIdentity);
  const {
    git: gitState,
    inputs: cacheInputs,
    settled,
  } = await openRunCache(repoRoot, base, lineage, dryRun === true);
  // Phase 0b — deterministic under-specification triage (plan-precheck.ts)
  // BEFORE any dispatch; fires only on the strongest signal.
  const pre = precheckDescriptor(type, descriptor, context);
  if (!pre.ok) {
    trace(`plan-driver: precheck fired — descriptor too thin, no dispatch paid (type=${type})`);
    return needsClarificationHalt({
      type,
      descriptor,
      timings: finishTimings(),
      questions: pre.questions,
    });
  }

  // #1541 (MEDIUM) — phase boundary: a kill between two awaits must not pay
  // for the next one.
  if (signal?.aborted) return cancelledResult(signal, input, "precheck", [], finishTimings());

  // Phase 1. ORDER IS LOAD-BEARING (vipune fixture run): renderPriorContext
  // clips at a fixed budget, so the operator's context-param entries — the
  // authority (D2) — come FIRST; vipune snapshots are the droppable tail.
  // #1043 — a filing run whose inputs and git HEAD match a confirmed dry run
  // reuses that dry run's inventory + investigation barrier (within the expiry).
  // A dry run never reads the cache: it is the thing being confirmed. The gap
  // gate is ALWAYS re-run, seeded with the prior dry run's gaps as settled.
  // #1043 — an identical confirm of a fileable dry run files its reviewed spec.
  const confirmed = await confirmVerbatim(
    gitState,
    cacheInputs,
    input,
    repoRoot,
    finishTimings,
    targetIdentity,
  );
  if (confirmed.result) return confirmed.result;
  // A filing run reuses a confirmed dry run's inventory + barrier in the expiry.
  const reused =
    !dryRun && gitState && cacheInputs
      ? await readInvestigationCache(gitState.cacheDir, cacheInputs)
      : undefined;

  // #1132: investigators and the inventory read origin/<default> (one fetch per run),
  // never the working tree; the cache key above uses the same SHA.
  const readRoot = base.readRoot;
  const inv = reused
    ? reused.cached.inventory
    : await timed("inventory", () => mechanicalInventory(readRoot, descriptor));
  // Phase 1's two-channel prior-context build (plan-prior-context-assembly.ts):
  // the child-prompt channel gets the FULL operator context (D2: the operator
  // is the authority — test-plan-prior-context.ts pins those caps), the
  // FILED-body inventory gets the untyped prose lines only (the typed-block
  // lines consumed by the directive parser render in their section, #858).
  // #1855: the operator OUTCOME block (`Done when:` / `Acceptance:` with bullets)
  // is a second operator-authority Acceptance-criteria source; the assembly
  // parsed it with the same line-index accounting, and it rides INSIDE
  // `directives` to BOTH draft sites (phase3Draft here, the round-2 gate below),
  // so there is no second channel that a round could drop.
  // #1856: the issue this plan is FOR. Only the risk child's view is filtered
  // with it (plan-investigate.ts); the angles, gate and body keep every row.
  const { priorContext, inventoryContext, directives } = assemblePriorContext(context, inv);
  if (signal?.aborted)
    return cancelledResult(signal, input, "inventory", priorContext, finishTimings());

  // Phase 1b + Phase 2 — ONE parallel barrier (plan-investigate.ts): the
  // duplicate-risk explore and the type-specialised angle set dispatch
  // together; wall clock is the slowest child, not their sum. The HIGH-risk
  // hard stop applies AFTER the barrier — semantics unchanged (a HIGH
  // verdict still refuses to file); the only trade is that on HIGH the
  // angle tokens are already spent, and HIGH is the rare case.
  const codeIds = codeIdentifiersIn(descriptor);
  // C5: an operator-pinned sub-issue count ("EXACTLY 5 sub-issues") is
  // threaded into the decomposition angle AND asserted by validateDraft.
  const pinnedSubIssues = parsePinnedSubIssueCount(`${descriptor}\n${context ?? ""}`);
  const barrier: InvestigationResult = reused
    ? await timed("investigate", async () => reused.cached.barrier)
    : await timed("investigate", () =>
        runInvestigation(dispatch, pi, {
          type,
          descriptor,
          repoRoot: readRoot,
          inv,
          priorContext,
          codeIdentifiers: codeIds,
          pinnedSubIssues,
          forbiddenPhrases: directives.neverClaim,
          ...(input.sourceIssue === undefined ? {} : { sourceIssue: input.sourceIssue }),
          statFn: getPlanStatFnOverride() ?? undefined,
          // #1541 review (MEDIUM) — the job's signal reaches the barrier's children.
          ...(signal ? { signal } : {}),
        }),
      );
  const { duplicateRisk, findings, neverClaimDisclosure } = barrier;
  if (signal?.aborted)
    return cancelledResult(signal, input, "investigate", priorContext, finishTimings());

  // Disclosed downstream (result text, details, drafted body) — a killed child
  // must never vanish silently (vipune fixture run, C3).
  const failedAngles = findings
    .filter((f) => !f.ok)
    .map((f) => ({ name: f.name, detail: f.failure ?? "failed" }));

  if (duplicateRisk?.level === "high") {
    return duplicateRiskHalt({
      type,
      descriptor,
      rationale: duplicateRisk.rationale,
      priorContext,
      failedAngles,
      timings: finishTimings(),
    });
  }

  // #633 aggregate all-angles-failed guard — plan-driver-halt.ts (fail-closed).
  const allFailed = allAnglesFailedHalt({
    type,
    descriptor,
    findings,
    priorContext,
    failedAngles,
    dryRun,
    timings: finishTimings,
  });
  if (allFailed) return allFailed;
  if (signal?.aborted)
    return cancelledResult(signal, input, "investigate", priorContext, finishTimings());

  // Phase 3 — draft WITHIN the forge body budget (plan-validate.ts owns the
  // stage-0/compaction/tooLarge policy); #1377 reserves the provenance lines
  // that are appended after the fitter so the FINAL body still fits the forge
  // cap. #1855: the operator OUTCOME block is part of `directives`, so the same
  // parsed object reaches the round-2 gate below and a corrective re-draft cannot
  // lose the operator's own criteria.
  const phase3 = phase3Draft({
    type,
    descriptor,
    findings,
    inventoryContext,
    directives,
    depth,
    provenance: input.provenance,
    priorContext,
    failedAngles,
    timings: finishTimings,
  });
  if (phase3.halt) return phase3.halt;
  const { chosenBudget, compacted, openQuestions, outOfScope } = phase3;
  let { title, body } = phase3;
  if (compacted) {
    trace(`plan-driver: body compacted to fit the forge limit (${body.length} chars)`);
    body += compactedDisclosure(chosenBudget);
  }
  // #677 — the NEVER CLAIM post-filter disclosure is appended to the drafted body
  // BEFORE validation (so the filed spec names what was dropped and why) and BEFORE
  // the gate (so the reviewer sees it, not a silent absence). Empty when nothing was
  // dropped — the body is unchanged.
  body += neverClaimDisclosureSection(neverClaimDisclosure);

  // Phase 3b — deterministic body validation (plan-validate.ts), BEFORE the gate:
  // a draft whose load-bearing sections fell back to placeholders never pays a
  // reviewer dispatch and never reaches the forge. The builder and its halt live in
  // plan-driver-validate.ts (the §12 size seam); the driver keeps the decision.
  const phase3b = await validatePhase3Draft({
    type,
    body,
    depth,
    context,
    pinnedSubIssues,
    directives,
    operatorOmitted: phase3.operatorOmitted,
    title,
    priorContext,
    failedAngles,
    finishTimings,
  });
  if (phase3b.halt) return phase3b.halt;

  // Phase 4 — gap gate: bug/feature/epic only (chore/spike are exempt — see
  // gapGateApplies). The loop, its prompts, its abort checks and its halt routing
  // are assembled in plan-driver-gate.ts (`phase4GapGate`); the driver keeps only
  // the decision the loop returns. The boundary check after it covers a kill that
  // lands while the loop's own work is settling.
  let gaps: PlanGap[] = [];
  let capHit = false;
  let capReason: PlanResult["capReason"];
  let residualForDisclosure: PlanGap[] = [];
  let openPoints: PlanGap[] = [];
  let rawUnparsedHead: string | undefined;

  let gateRan = false;
  if (gapGateApplies(type)) {
    gateRan = true;
    const phase4 = await phase4GapGate({
      dispatch,
      pi,
      repoRoot,
      ...(signal ? { signal } : {}),
      type,
      descriptor,
      getBody: () => body,
      setTitleBody: (t, b) => {
        title = t;
        body = b;
      },
      findings,
      priorContext,
      inventoryContext,
      directives,
      settled,
      openQuestions,
      outOfScope,
      depth,
      chosenBudget,
      timed,
      correctiveRedraft,
      input,
      failedAngles,
      finishTimings,
    });
    if (phase4.halt) return phase4.halt;
    gaps = phase4.gaps;
    capHit = phase4.capHit;
    capReason = phase4.capReason;
    residualForDisclosure = phase4.residualForDisclosure;
    openPoints = phase4.openPoints;
    rawUnparsedHead = phase4.rawUnparsedHead;
  }
  if (signal?.aborted)
    return cancelledResult(signal, input, "gap-gate", priorContext, finishTimings());

  // #1383: plan-dropped-artifact.ts decides where the omitted items live.
  const dl = await finalizeDroppedDisclosure({ repoRoot, descriptor, type, openPoints });
  if (dl.omitted) body = dl.repoint(body);
  // The filed/shown body, assembled at the ONE home for it (plan-gap-disclosure.ts,
  // with the argument order in plan-driver-final-body.ts — the §12 size seam).
  const finalBody = assembleFinalBody({
    body,
    residual: residualForDisclosure,
    openPoints,
    baseFallback: base.baseFallback,
    images,
    provenance: input.provenance,
    // #1856: the exclusion disclosure renders only when the caller named the
    // issue this plan is for, and only from the verdict the barrier recorded.
    duplicate: { risk: duplicateRisk, sourceIssue: input.sourceIssue },
    piSpec: { type, title },
  });

  const resolvedGaps = gateRan ? gaps : [];
  const held = heldForReview(input, confirmed.missReason, title, finalBody, targetIdentity);
  const asDryRun = dryRun || !!held;

  // Phase 5 — file (unless dryRun OR the cap routed to surface). D2: the
  // cap-routing to "surface" (a CRITICAL remains — the CRITICAL-only terminal rule,
  // #664 transposed) does NOT file. D7: the filing failure is DISCRIMINATED and
  // carried on the result, and the operator-visible text (plan-tool.ts) surfaces the
  // reason including the forge stderr without requiring PI_ENSEMBLE_DEBUG. The
  // cap-skip routing and the single filing pass live in plan-phase5.ts (the seam the
  // 500-line cap asked for), keeping the driver's orchestration visible here.
  const { issueUrl, issueNumber, filingFailure } = await phase5FilingFailure({
    capReason,
    dryRun: asDryRun,
    title,
    finalBody,
    context,
    repoRoot,
    rawUnparsedHead,
    labels: input.labels,
    timed,
  });

  // #1043: every dry run that reached the end is cached with its reviewed spec
  // (the earlier "successful dry run only" rule was superseded); a filed run
  // consumes the entry (plan-confirm.ts settlePlanCache). #1854: the entry also
  // records the repository it was reviewed FOR, so a confirm aimed at another one
  // is named as such instead of surfacing as an opaque digest mismatch.
  await settlePlanCache(gitState, cacheInputs, {
    dryRun: asDryRun,
    issueUrl,
    filingFailure,
    inventory: inv,
    barrier,
    gaps: resolvedGaps,
    title,
    spec: finalBody,
    priorContext: inventoryContext.slice(0, 15),
    failedAngles,
    // #1377: the reviewed entry records what the filing would send beyond the
    // body, so the verbatim confirm files the same labels and provenance.
    labels: input.labels,
    provenance: input.provenance,
    target: targetIdentity,
  });

  // #633: angles AND how many produced structured items (the line lives in
  // plan-dropped-artifact.ts, which is where the driver's size seam sits).
  tracePlanRun({ type, findings, gaps, issueUrl, dryRun: !!dryRun, capReason });

  return buildFinalPlanResult({
    type,
    title,
    spec: finalBody,
    gaps: resolvedGaps,
    priorContext: inventoryContext.slice(0, 15),
    issueUrl,
    capHit,
    capReason,
    residualForDisclosure,
    filingFailure,
    failedAngles,
    compacted,
    issueNumber,
    // #1854: the run's destination, plus the digest inputs the builder folds into
    // the reviewedDigest (plan-driver-result.ts).
    targetIdentity,
    labels: input.labels,
    provenance: input.provenance,
    asDryRun,
    // #1383: the durable full dropped list, so plan-tool.ts names real bytes.
    droppedListFile: dl.file,
    investigationReused: reused ? { ageMs: reused.ageMs } : undefined,
    reviewedSpecChanged: held,
    timings: finishTimings(),
  });
}

// Re-export for consumers that import from plan-driver.ts
export { classifyPlanType, planTitle } from "./plan-types.ts";
export { codeIdentifiersIn, draftSpec } from "./plan-draft.ts";
// Test seam re-export (the alias now lives in plan-gaps.ts, its home).
export { parseGapsForTest } from "./plan-gaps.ts";
export {
  type PlanDispatchFn,
  setPlanDispatch,
  setPlanRedraft,
  setPlanStatFn,
} from "./plan-driver-seams.ts";
