/**
 * plan-driver — the compiled five-phase /plan pipeline (orchestrator).
 *
 * A compiled driver PM calls, not a prose flow PM re-implements. The
 * mode-independent issue-creation guard (issue-creation-guard.ts) makes
 * the replacement safe: direct `gh issue create` bash is refused for
 * every role in every mode.
 *
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
 */

import { dispatchCore } from "./dispatch.ts";
import { type PlanBase, withPlanBase } from "./plan-base-tree.ts";
import { confirmVerbatim, heldForReview, settlePlanCache } from "./plan-confirm.ts";
import { codeIdentifiersIn, draftSpec, mechanicalInventory } from "./plan-draft.ts";
import {
  allAnglesFailedHalt,
  buildPlanResult,
  correctiveRedraftError,
  haltResult,
  phaseTimer,
} from "./plan-driver-halt.ts";
import { phase3Draft } from "./plan-driver-phase3.ts";
import {
  type PlanDispatchFn,
  getPlanDispatchOverride,
  getPlanStatFnOverride,
} from "./plan-driver-seams.ts";
import { reviewedDigestOf } from "./plan-filing-claim.ts";
import { filedBodyOf, settledGapsSection } from "./plan-gap-disclosure.ts";
import { type GapGateLoopResult, runGapGateLoop } from "./plan-gaps.ts";
import { type CarriedCritical, gapGatePrompt, gapGateVerifyPrompt } from "./plan-gate-prompt.ts";
import { loadPlanImages, planImageLinksSection, withPlanImages } from "./plan-images.ts";
import {
  type InvestigationResult,
  PLAN_DISPATCH_TIMEOUT_MS,
  PLAN_MARKER_CHILD_ARGS,
  runInvestigation,
} from "./plan-investigate.ts";
import {
  dropInvestigationCache,
  readInvestigationCache,
  readSettledGaps,
  resolvePlanGitState,
} from "./plan-investigation-cache.ts";
import { phase5FilingFailure } from "./plan-phase5.ts";
import { precheckDescriptor } from "./plan-precheck.ts";
import { assemblePriorContext } from "./plan-prior-context-assembly.ts";
import { withProvenance } from "./plan-provenance.ts";
import {
  type PlanDriverInput,
  type PlanGap,
  type PlanResult,
  classifyPlanType,
  planTitle,
} from "./plan-types.ts";
import { FORGE_BODY_MAX, parsePinnedSubIssueCount, validateDraft } from "./plan-validate.ts";
import { type ResolvedDecision, buildResolvedDecisions } from "./plan-writeback.ts";
import { trace } from "./trace.ts";
import type { DriverHost } from "./work-driver-host.ts";

const GAP_GATE_MAX_ITERATIONS = 2;

// Phase-4 prompts (round-1 review + round-2 scoped verification) live in
// plan-gate-prompt.ts; re-exported here for the existing consumers.
export { gapGatePrompt } from "./plan-gate-prompt.ts";

// ---------------------------------------------------------------------------
// runPlanPipeline
// ---------------------------------------------------------------------------

export async function runPlanPipeline(
  pi: DriverHost,
  input: PlanDriverInput,
  repoRoot: string,
): Promise<PlanResult> {
  // #1132: one origin fetch per run; the base tree is removed when the run ends.
  return withPlanBase(repoRoot, async (base) => {
    const result = await runPipelineOn(pi, input, repoRoot, base);
    return base.baseFallback ? { ...result, baseFallback: base.baseFallback } : result;
  });
}

async function runPipelineOn(
  pi: DriverHost,
  input: PlanDriverInput,
  repoRoot: string,
  base: PlanBase,
): Promise<PlanResult> {
  // The source issue's images (plan-images.ts): with every child, links in the body.
  const images = await loadPlanImages();
  const dispatch = withPlanImages(images, getPlanDispatchOverride() ?? dispatchCore);
  const { descriptor, context, dryRun } = input;
  const type = classifyPlanType(descriptor, input.type);
  const depth = input.depth ?? 0;

  // Per-phase wall-clock record (research next-step #1: measure, then cut).
  const { timed, finishTimings } = phaseTimer();

  // #1043 — the cache lineage at git HEAD. A dry run never READS the investigation
  // cache (it is the thing confirmed); it DROPS the lineage first, so a halting dry
  // run leaves no fileable verdict. Its settled gaps are read before the drop.
  // #1132: "HEAD" here is origin/<default> (the run's base SHA), not the local HEAD.
  const gitState = await resolvePlanGitState(repoRoot, base);
  const cacheInputs = gitState
    ? { descriptor, context, type, keySha: gitState.keySha, depth }
    : undefined;
  const settled: PlanGap[] =
    gitState && cacheInputs ? await readSettledGaps(gitState.cacheDir, cacheInputs) : [];
  if (dryRun && gitState && cacheInputs) {
    await dropInvestigationCache(gitState.cacheDir, cacheInputs);
  }

  // Phase 0b — deterministic under-specification triage (plan-precheck.ts)
  // BEFORE any dispatch; fires only on the strongest signal.
  const pre = precheckDescriptor(type, descriptor, context);
  if (!pre.ok) {
    trace(`plan-driver: precheck fired — descriptor too thin, no dispatch paid (type=${type})`);
    return haltResult({
      type,
      title: planTitle(descriptor, type),
      spec: `(spec not drafted — the descriptor is too thin to ground an investigation)\n\nAnswer these and re-run start_plan_driver with a fuller descriptor or a context param:\n${pre.questions.map((q) => `- ${q}`).join("\n")}`,
      priorContext: [],
      failure: {
        reason: "needs-clarification",
        detail:
          "the descriptor is under the word floor with no code identifier and no context param — investigation was deliberately skipped before any dispatch",
      },
      timings: finishTimings(),
    });
  }

  // Phase 1. ORDER IS LOAD-BEARING (vipune fixture run): renderPriorContext
  // clips at a fixed budget, so the operator's context-param entries — the
  // authority (D2) — come FIRST; vipune snapshots are the droppable tail.
  // #1043 — a filing run whose inputs and git HEAD match a confirmed dry run
  // reuses that dry run's inventory + investigation barrier (within the expiry).
  // A dry run never reads the cache: it is the thing being confirmed. The gap
  // gate is ALWAYS re-run, seeded with the prior dry run's gaps as settled.
  // #1043 — an identical confirm of a fileable dry run files its reviewed spec.
  const confirmed = await confirmVerbatim(gitState, cacheInputs, input, repoRoot, finishTimings);
  if (confirmed.result) return confirmed.result;
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
  const { priorContext, inventoryContext, directives } = assemblePriorContext(context, inv);

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
          statFn: getPlanStatFnOverride() ?? undefined,
        }),
      );

  const { duplicateRisk, findings, neverClaimDisclosure } = barrier;

  // Disclosed downstream (result text, details, drafted body) — a killed
  // child must never vanish silently (vipune fixture run, C3).
  const failedAngles = findings
    .filter((f) => !f.ok)
    .map((f) => ({ name: f.name, detail: f.failure ?? "failed" }));

  if (duplicateRisk && duplicateRisk.level === "high") {
    // C6: a structured not-filed result instead of a bare throw — the
    // operator gets the rationale AND the recovery path (acknowledge the
    // named issue via the context param; the risk child reads it and a
    // reconciled issue cannot raise the risk above medium).
    return haltResult({
      type,
      title: planTitle(descriptor, type),
      spec: `(spec not drafted — duplicate risk HIGH)\n\nRationale from the risk check:\n${duplicateRisk.rationale}\n\nIf this ticket deliberately reverses or extends the named issue, re-run start_plan_driver with a context param acknowledging it (e.g. "this deliberately reverses #103 because …") — an acknowledged issue is reconciled, not a duplicate. Full rationale: /runs → plan-duplicate-risk.`,
      priorContext,
      failure: {
        reason: "duplicate-risk",
        detail: `duplicate risk HIGH — ${duplicateRisk.rationale.slice(0, 300)}`,
      },
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

  // Phase 3 — draft WITHIN the forge body budget (vipune session: four
  // filings hit the 65,536-char wall after clean gates; plan-validate.ts
  // owns the stage-0/compaction/tooLarge policy).
  //
  // #1377: the caller's provenance lines are appended by code AFTER the fitter,
  // so compaction can never trim them — and their rendered size is reserved out
  // of the budget up front so the FINAL body still fits the forge cap. The
  // reservation is 0 with no provenance, so an existing caller's chosen body is
  // byte-identical. The draft itself is assembled by phase3Draft (one home for
  // the fitter's 12 positional args and its tooLarge halt).
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
    body += `\n\n> Compacted to fit the forge's ${FORGE_BODY_MAX}-char body limit (per-section items capped at ${chosenBudget.maxItemsPerSection}, item text clipped at ${chosenBudget.itemClipChars} chars); full findings live in the run transcripts (/runs).`;
  }
  // #677 — the NEVER CLAIM post-filter disclosure, appended to the drafted
  // body BEFORE validation (so the filed spec names what was dropped and
  // why) and BEFORE the gate (so the reviewer sees the disclosure, not a
  // silent absence). Empty when nothing was dropped — the body is
  // unchanged, and there is nothing to disclose.
  if (neverClaimDisclosure.length > 0) {
    body += `\n\n> **NEVER CLAIM filter disclosure** — the operator's NEVER CLAIM block caused the following structured items to be dropped before drafting (exact normalised substring match, verbatim-only; paraphrases are not matched and were left in place):\n${neverClaimDisclosure
      .map((d) => `> ${d}`)
      .join("\n")}`;
  }

  // Phase 3b — deterministic body validation (plan-validate.ts), BEFORE the
  // gate: a draft whose load-bearing sections fell back to placeholders
  // never pays a reviewer dispatch and never reaches the forge.
  const draftCheck = validateDraft(type, body, depth, {
    operatorSupplied: !!context?.trim(),
    pinnedSubIssues,
    forbiddenPhrases: directives.neverClaim,
    operatorOmitted: phase3.operatorOmitted,
  });
  if (!draftCheck.ok) {
    trace(`plan-driver: draft validation failed — ${draftCheck.problems.join("; ")}`);
    return haltResult({
      type,
      title,
      spec: body,
      priorContext,
      failure: {
        reason: "draft-invalid",
        detail: `the drafted body failed deterministic validation, so it was not reviewed or filed: ${draftCheck.problems.join("; ")}. Re-run start_plan_driver (the angles are re-dispatched), or supply the missing content via the context param (e.g. an ACCEPTANCE CRITERIA block).`,
      },
      failedAngles,
      timings: finishTimings(),
    });
  }

  // Phase 4 — gap gate: bug/feature/epic only. Chore/spike are
  // low-blast-radius and their gate is the deterministic validation above —
  // no env knob (operator decision 2026-09-09: fewer knobs, better
  // defaults; this also removes run-to-run gate variance for those types).
  const gapGateEnabled = type !== "chore" && type !== "spike";
  let gaps: PlanGap[] = [];
  let capHit = false;
  let capReason: PlanResult["capReason"];
  let residualForDisclosure: PlanGap[] = [];
  let openPoints: PlanGap[] = [];
  let rawUnparsedHead: string | undefined;

  // The carried CRITICAL decisions from the last corrective re-draft — what
  // round 2's SCOPED VERIFICATION verifies (set in onCorrective below).
  let lastCarried: CarriedCritical[] = [];

  if (gapGateEnabled) {
    // Phase 4 — the gap-gate loop (plan-gaps.ts: runGapGateLoop; no-op
    // rounds eliminated; residual union disclosed across rounds).
    const loopResult: GapGateLoopResult = await timed("gap-gate", () =>
      runGapGateLoop(
        // Same bounds as every plan child: cwd pinned, 30-min timeout,
        // --no-skills (marker-line reviewer, no reporter).
        (spec, opts) =>
          dispatch(
            pi,
            { ...spec, cwd: repoRoot },
            { ...opts, timeoutMs: PLAN_DISPATCH_TIMEOUT_MS, extraArgs: PLAN_MARKER_CHILD_ARGS },
          ),
        // Round 1: full GAP DETECTION review. Round 2 (fires only after a
        // CRITICAL corrective re-draft): SCOPED VERIFICATION of the carried
        // resolutions — not a second full review (plan-gate-prompt.ts).
        (iteration) =>
          iteration <= 1 || lastCarried.length === 0
            ? gapGatePrompt(body, findings, priorContext, directives.neverClaim) +
              settledGapsSection(settled)
            : gapGateVerifyPrompt(body, lastCarried),
        GAP_GATE_MAX_ITERATIONS,
        (blocking: PlanGap[]) => {
          // PR #640: resolve destinations and re-draft in ONE site. The wide
          // catch's disclosure (plan-driver-halt.ts) names what was computed
          // before the throw — a crash must not silently lose the decisions.
          let computed: ResolvedDecision[] = [];
          let writtenOutcomes: { applied: boolean; heading: string }[] = [];
          try {
            const { decisions, writebackMap } = buildResolvedDecisions(blocking, type);
            computed = decisions;
            // Same budget as the fitted round-1 draft: deterministic across
            // rounds, and the round-2 body stays under the forge limit.
            const redraft = draftSpec(
              type,
              descriptor,
              findings,
              inventoryContext,
              openQuestions,
              outOfScope,
              depth,
              directives,
              decisions,
              writebackMap,
              chosenBudget,
            );
            if (redraft.operatorOmitted.length) throw new Error("redraft truncated operator items");
            // Marked decisions (writtenBack from the splice, never predicted).
            writtenOutcomes = redraft.resolvedDecisions.map((d) => ({
              applied: d.writtenBack ?? false,
              heading: d.writebackHeading ?? "(no destination — status open)",
            }));
            lastCarried = redraft.resolvedDecisions.map((d) => ({
              description: d.description,
              resolution: d.resolution,
              writtenBack: d.writtenBack ?? false,
              heading: d.writebackHeading ?? "Open Questions",
            }));
            ({ title, body } = redraft);
          } catch (e) {
            throw correctiveRedraftError(computed, writtenOutcomes, e);
          }
        },
      ),
    );
    gaps = loopResult.gaps;
    capHit = loopResult.capHit;
    capReason = loopResult.capReason;
    residualForDisclosure = loopResult.residualForDisclosure;
    openPoints = loopResult.openPoints;
    rawUnparsedHead = loopResult.rawUnparsedHead;
  }

  // D2: when the cap routed to filing, the spec that gets filed carries the
  // residual disclosure. Append it HERE, before fileIssue, so the single
  // filing pass below sees the final body.
  // #1132: open points and the base fallback are disclosed in the body too.
  // #1377: the caller's provenance wraps the whole thing — italic line first,
  // marker comment last — appended by code, after every LLM stage and after the
  // budget fitter, so what the operator reviewed is what the forge receives.
  const finalBody = withProvenance(
    filedBodyOf(body, residualForDisclosure, openPoints, base.baseFallback) +
      planImageLinksSection(images),
    input.provenance,
  );

  const resolvedGaps = gapGateEnabled ? gaps : [];
  const held = heldForReview(input, confirmed.missReason, title, finalBody);
  const asDryRun = dryRun || !!held;

  // Phase 5 — file (unless dryRun OR the cap routed to surface). D2: when
  // the cap routed to "surface" (CRITICAL remaining — the CRITICAL-only
  // terminal rule, #664 transposed), do NOT file — surface to the operator. D7: the filing failure is DISCRIMINATED and
  // carried on the result; the operator-visible text (plan-tool.ts) surfaces
  // the reason including the forge stderr, without requiring PI_ENSEMBLE_DEBUG.
  // The cap-skip routing + the single filing pass (moved to plan-phase5.ts
  // along the 500-line seam) keep the driver's orchestration visible here.
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
  // consumes the entry (plan-confirm.ts settlePlanCache).
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
  });

  // #633: report BOTH how many angles were dispatched and how many produced
  // structured items — `angles=` alone read as "3 angles ran" even when all
  // three returned prose-only (the all-angles-failed case the guard above
  // halts for now still surfaces the count when it fires).
  const structuredCount = findings.filter((f) => f.toolUses.length > 0).length;
  trace(
    `plan-driver: type=${type} angles=${findings.length} structured=${structuredCount} gaps=${gaps.length} filed=${!!issueUrl} dryRun=${!!dryRun} capReason=${capReason ?? "none"}`,
  );

  return buildPlanResult({
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
    // #1043: a fileable dry run reports the digest a verbatim filing must echo.
    // #1377: labels and provenance are digest inputs — labels are arguments to
    // the create call (never body text), and the provenance lines are appended
    // after the reviewed body by code, so neither is covered by the body hash
    // alone. Filing the reviewed bytes under different labels is a mismatch.
    reviewedDigest:
      asDryRun && !filingFailure
        ? reviewedDigestOf(title, finalBody, {
            labels: input.labels,
            provenance: input.provenance,
          })
        : undefined,
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
export { type PlanDispatchFn, setPlanDispatch, setPlanStatFn } from "./plan-driver-seams.ts";
