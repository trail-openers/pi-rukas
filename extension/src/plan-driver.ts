/**
 * plan-driver — the compiled five-phase /plan pipeline (orchestrator).
 *
 * /plan used to be a 473-line prose body sent into PM's context. PM was then
 * left to run the five phases by hand, with a self-judged "triviality test"
 * and no gate between that self-judgment and `gh issue create`. In one
 * session PM filed three non-trivial issues inline (#591, #592, #594) — no
 * adversarial gap gate, no user confirmation, no structured spec body for
 * /work to consume.
 *
 * This module is the same shape as the `start_work_driver` fix: a compiled
 * driver PM calls, not a prose flow PM re-implements. It replaces the /plan
 * body, and the mode-independent issue-creation guard (issue-creation-guard.ts)
 * is what makes the replacement safe: direct `gh issue create` bash is
 * refused for every role in every mode, so the only way left to file a
 * ticket is this driver or a human typing the command themselves.
 *
 * Phase compilation (each phase's detail lives in its module's header):
 *
 *   0  Classify [plan-types.ts] · 0b Precheck — deterministic
 *      under-specification triage before ANY dispatch [plan-precheck.ts]
 *   1  Inventory — vipune + `gh issue list`, driver-run [plan-draft.ts]
 *   1b+2 Investigate — duplicate-risk explore + type-specialised angles as
 *      ONE parallel barrier; the HIGH-risk stop applies after the barrier
 *      and returns a structured `duplicate-risk` result (never a throw)
 *      [plan-investigate.ts]
 *   3  Draft [plan-draft.ts: draftSpec] · 3b Validate — deterministic body
 *      validation BEFORE the gate [plan-validate.ts]
 *   4  Gap gate — bug/feature/epic only; CRITICAL-only terminal rule,
 *      D1/D2/D3 routing in plan-gaps.ts; round 2 is a SCOPED VERIFICATION
 *      [plan-gate-prompt.ts]
 *   5  File — forge issueCreate; DISCRIMINATED failures (D7)
 *      [plan-filing.ts]
 *
 * dryRun is the confirmation seam: `dryRun: true` returns the spec + gaps
 * without filing; PM shows it to the operator; on confirmation the driver
 * is re-called with `dryRun` omitted. Every phase is timed
 * (PlanResult.timings — measure, then cut).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dispatchCore } from "./dispatch.ts";
import {
  type AngleFindings,
  VIPUNE_PRIOR_SOURCE,
  codeIdentifiersIn,
  draftSpec,
  mechanicalInventory,
  parseOperatorDirectives,
} from "./plan-draft.ts";
import { type FilingFailure, fileIssue, getPlanForge, planForgeFor } from "./plan-filing.ts";
import { type CarriedCritical, gapGatePrompt, gapGateVerifyPrompt } from "./plan-gate-prompt.ts";
import {
  PLAN_DISPATCH_TIMEOUT_MS,
  PLAN_MARKER_CHILD_ARGS,
  runInvestigation,
} from "./plan-investigate.ts";
import { precheckDescriptor } from "./plan-precheck.ts";
import { parsePinnedSubIssueCount, validateDraft } from "./plan-validate.ts";

/**
 * The dispatch seam, injectable so the smoke test can drive the pipeline with
 * a stubbed `dispatchCore` (ESM namespaces are not mutable in Bun — this is
 * the `FsOps`-style DI the agents-md core uses for the same reason).
 */
export type PlanDispatchFn = typeof dispatchCore;

let _dispatchOverride: PlanDispatchFn | null = null;

/** Set a dispatch stub for the next run (tests). Pass `null` to clear. */
export function setPlanDispatch(fn: PlanDispatchFn | null): void {
  _dispatchOverride = fn;
}
import {
  type GapGateLoopResult,
  parseGaps,
  residualGapsSection,
  runGapGateLoop,
} from "./plan-gaps.ts";
import {
  type PlanDriverInput,
  type PlanGap,
  type PlanPhaseTiming,
  type PlanResult,
  classifyPlanType,
  planTitle,
} from "./plan-types.ts";
import { type ResolvedDecision, buildResolvedDecisions } from "./plan-writeback.ts";
import { trace } from "./trace.ts";

const GAP_GATE_MAX_ITERATIONS = 2;

// Phase-4 prompts (round-1 review + round-2 scoped verification) live in
// plan-gate-prompt.ts; re-exported here for the existing consumers.
export { gapGatePrompt } from "./plan-gate-prompt.ts";

// ---------------------------------------------------------------------------
// runPlanPipeline
// ---------------------------------------------------------------------------

export async function runPlanPipeline(
  pi: ExtensionAPI,
  input: PlanDriverInput,
  repoRoot: string,
): Promise<PlanResult> {
  const dispatch: PlanDispatchFn = _dispatchOverride ?? dispatchCore;
  const { descriptor, context, dryRun } = input;
  const type = classifyPlanType(descriptor, input.type);
  const depth = input.depth ?? 0;

  // Per-phase wall-clock record (research next-step #1: measure, then cut).
  const timings: PlanPhaseTiming[] = [];
  const pipelineStart = Date.now();
  const timed = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      timings.push({ phase, ms: Date.now() - t0 });
    }
  };
  const finishTimings = (): PlanPhaseTiming[] => [
    ...timings,
    { phase: "total", ms: Date.now() - pipelineStart },
  ];

  // Phase 0b — deterministic under-specification triage (plan-precheck.ts),
  // BEFORE any dispatch or inventory work; fires only on the strongest
  // signal, so a legitimately terse descriptor is never blocked.
  const pre = precheckDescriptor(type, descriptor, context);
  if (!pre.ok) {
    trace(`plan-driver: precheck fired — descriptor too thin, no dispatch paid (type=${type})`);
    return {
      type,
      title: planTitle(descriptor, type),
      spec: `(spec not drafted — the descriptor is too thin to ground an investigation)\n\nAnswer these and re-run start_plan_driver with a fuller descriptor or a context param:\n${pre.questions.map((q) => `- ${q}`).join("\n")}`,
      gaps: [],
      priorContext: [],
      filed: false,
      filingFailure: {
        reason: "needs-clarification",
        detail:
          "the descriptor is under the word floor with no code identifier and no context param — investigation was deliberately skipped before any dispatch",
      },
      timings: finishTimings(),
    };
  }

  // Phase 1. ORDER IS LOAD-BEARING (vipune fixture run): renderPriorContext
  // clips at a fixed budget, so the operator's context-param entries — the
  // authority (D2) — come FIRST; vipune snapshots are the droppable tail.
  const inv = await timed("inventory", () => mechanicalInventory(repoRoot, descriptor));
  const priorContext: { source: string; fact: string }[] = [];
  // D7: operator-supplied typed fields (ACCEPTANCE CRITERIA / PITFALLS /
  // OUT OF SCOPE blocks in the context param) take precedence over
  // specialist output for those fields — parsed once, threaded to draftSpec.
  const directives = parseOperatorDirectives(context);
  if (context && context.trim().length > 0) {
    for (const line of context.trim().split("\n")) {
      if (line.trim())
        // D2: no 200-char clipping of operator context — the operator is the
        // authority and the inventory renders it verbatim.
        priorContext.push({ source: "context param", fact: line.trim() });
    }
  }
  priorContext.push(
    ...inv.related
      .slice(0, 5)
      .map((r) => ({ source: `issue #${r.number} (${r.state})`, fact: r.title })),
    // D6: vipune hits are tagged as prior snapshots (may be stale); the
    // precedence note in the child prompts makes live context win on conflict.
    ...inv.memory.map((h) => ({ source: VIPUNE_PRIOR_SOURCE, fact: h.content.slice(0, 200) })),
  );

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
  const {
    duplicateRisk,
    findings,
  }: { duplicateRisk?: { level: string; rationale: string }; findings: AngleFindings[] } =
    await timed("investigate", () =>
      runInvestigation(dispatch, pi, {
        type,
        descriptor,
        repoRoot,
        inv,
        priorContext,
        codeIdentifiers: codeIds,
        pinnedSubIssues,
      }),
    );

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
    return {
      type,
      title: planTitle(descriptor, type),
      spec: `(spec not drafted — duplicate risk HIGH)\n\nRationale from the risk check:\n${duplicateRisk.rationale}\n\nIf this ticket deliberately reverses or extends the named issue, re-run start_plan_driver with a context param acknowledging it (e.g. "this deliberately reverses #103 because …") — an acknowledged issue is reconciled, not a duplicate. Full rationale: /runs → plan-duplicate-risk.`,
      gaps: [],
      priorContext: priorContext.slice(0, 15),
      filed: false,
      filingFailure: {
        reason: "duplicate-risk",
        detail: `duplicate risk HIGH — ${duplicateRisk.rationale.slice(0, 300)}`,
      },
      failedAngles: failedAngles.length > 0 ? failedAngles : undefined,
      timings: finishTimings(),
    };
  }

  // #633 aggregate all-angles-failed guard (fail-closed): if EVERY angle
  // produced zero structured items, every typed section would silently fall
  // back — halt before draftSpec/fileIssue with the discriminated
  // `skipped-all-angles-failed` reason instead ("deliberately skipped",
  // never "filing failed").
  const withItems = findings.filter((f) => f.toolUses.length > 0).length;
  if (findings.length > 0 && withItems === 0) {
    trace(
      `plan-driver: ALL ${findings.length} angles produced zero structured items (prose-only or schema-invalid calls) — halting, no spec filed`,
    );
    const angleNames = findings.map((f) => f.name).join(", ");
    const spec = `(spec not drafted — all investigation angles returned zero structured items)\n\nDispatched angles: ${angleNames}\n\nEach angle returned either prose only (no report_plan_item tool calls) or schema-invalid calls only. This usually means the reporter extension was not loaded, or the model did not make the tool calls. Re-run start_plan_driver — the investigation children are re-dispatched; if this recurs, check the plan-reporter extension registration (PLAN_REPORTER_PATH).`;
    const title = planTitle(descriptor, type);
    trace(
      `plan-driver: type=${type} angles=${findings.length} structured=${withItems} gaps=0 filed=false dryRun=${!!dryRun} ALL-ANGLES-FAILED`,
    );
    return {
      type,
      title,
      spec,
      gaps: [],
      priorContext: priorContext.slice(0, 15),
      filed: false,
      issueUrl: undefined,
      capHit: true,
      filingFailure: {
        reason: "skipped-all-angles-failed",
        detail: `all ${findings.length} angles produced zero structured items — filing was deliberately skipped (not a forge failure)`,
      },
      failedAngles: failedAngles.length > 0 ? failedAngles : undefined,
      timings: finishTimings(),
    };
  }

  // Phase 3
  const openQuestions: string[] = [];
  const outOfScope: string[] = [];
  let { title, body } = draftSpec(
    type,
    descriptor,
    findings,
    priorContext,
    openQuestions,
    outOfScope,
    depth,
    directives,
    [],
  );

  // Phase 3b — deterministic body validation (plan-validate.ts), BEFORE the
  // gate: a draft whose load-bearing sections fell back to placeholders
  // never pays a reviewer dispatch and never reaches the forge.
  const draftCheck = validateDraft(type, body, depth, {
    operatorSupplied: !!context?.trim(),
    pinnedSubIssues,
  });
  if (!draftCheck.ok) {
    trace(`plan-driver: draft validation failed — ${draftCheck.problems.join("; ")}`);
    return {
      type,
      title,
      spec: body,
      gaps: [],
      priorContext: priorContext.slice(0, 15),
      filed: false,
      filingFailure: {
        reason: "draft-invalid",
        detail: `the drafted body failed deterministic validation, so it was not reviewed or filed: ${draftCheck.problems.join("; ")}. Re-run start_plan_driver (the angles are re-dispatched), or supply the missing content via the context param (e.g. an ACCEPTANCE CRITERIA block).`,
      },
      failedAngles: failedAngles.length > 0 ? failedAngles : undefined,
      timings: finishTimings(),
    };
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
  let rawUnparsedHead: string | undefined;

  // The carried CRITICAL decisions from the last corrective re-draft — what
  // round 2's SCOPED VERIFICATION verifies (set in onCorrective below).
  let lastCarried: CarriedCritical[] = [];

  if (gapGateEnabled) {
    // Phase 4 — the gap-gate loop (extracted to plan-gaps.ts: runGapGateLoop).
    // Two fixes from the CRITICAL-only terminal rule follow-up:
    // 1. NO-OP ROUND ELIMINATED: corrective fires only when blocking is
    //    non-empty (CRITICAL present); zero CRITICAL → straight to cap/file.
    // 2. UNION DISCLOSURE: non-blocking findings accumulate across rounds
    //    (deduped by exact description string), so the residual section
    //    discloses the union, not just the last round.
    const loopResult: GapGateLoopResult = await timed("gap-gate", () =>
      runGapGateLoop(
        // The gate child gets the same bounds as every plan child: cwd
        // pinned to the repo root, the 30-min timeout instead of the 2-hour
        // backstop, and --no-skills (a marker-line reviewer, no reporter).
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
            ? gapGatePrompt(body, findings, priorContext)
            : gapGateVerifyPrompt(body, lastCarried),
        GAP_GATE_MAX_ITERATIONS,
        (blocking: PlanGap[]) => {
          // PR #640: resolve destinations here, splice in draftSpec (single site).
          // Catch is WIDE: covers destination-resolution + re-draft; cause preserves stack.
          let computed: ResolvedDecision[] = [];
          let writebackMap: Map<string, string[]> | null = null;
          let writtenOutcomes: { applied: boolean; heading: string }[] = [];
          try {
            ({ decisions: computed, writebackMap: writebackMap } = buildResolvedDecisions(
              blocking,
              type,
            ));
            const redraft = draftSpec(
              type,
              descriptor,
              findings,
              priorContext,
              openQuestions,
              outOfScope,
              depth,
              directives,
              computed,
              writebackMap,
            );
            // Re-draft RETURN: marked decisions (writtenBack from the splice,
            // not predicted). Body/title re-assigned for round 2.
            ({ title, body } = redraft);
            writtenOutcomes = redraft.resolvedDecisions.map((d) => ({
              applied: d.writtenBack ?? false,
              heading: d.writebackHeading ?? "(no destination — status open)",
            }));
            // What round 2's scoped verification will check (writtenBack
            // produced by the splice, never predicted).
            lastCarried = redraft.resolvedDecisions.map((d) => ({
              description: d.description,
              resolution: d.resolution,
              writtenBack: d.writtenBack ?? false,
              heading: d.writebackHeading ?? "Open Questions",
            }));
          } catch (e) {
            // Disclosure: names what was computed before the throw.
            const disclosed = computed.length
              ? computed
                  .map((d, i) => {
                    const o = writtenOutcomes[i];
                    const s = o
                      ? o.applied
                        ? `• written back to ${o.heading}: ${d.description} → ${d.resolution}`
                        : `• NOT written back (open, decision owner operator): ${d.description} → ${d.resolution}`
                      : `• not yet applied: ${d.description} → ${d.resolution}`;
                    return s;
                  })
                  .join("\n")
              : "(no decisions computed — the throw preceded the re-draft)";
            const err = e instanceof Error ? e : new Error(String(e));
            const msg = err.message;
            throw new Error(
              `corrective re-draft failed AFTER computing ${computed.length} carried gap decision(s) (the writeback decisions are disclosed here so the loss is visible):\n${disclosed}\noriginal error: ${msg}`,
              { cause: err },
            );
          }
        },
      ),
    );
    gaps = loopResult.gaps;
    capHit = loopResult.capHit;
    capReason = loopResult.capReason;
    residualForDisclosure = loopResult.residualForDisclosure;
    rawUnparsedHead = loopResult.rawUnparsedHead;
  }

  // D2: when the cap routed to filing, the spec that gets filed carries the
  // residual disclosure. Append it HERE, before fileIssue, so the single
  // filing pass below sees the final body.
  const finalBody =
    residualForDisclosure.length > 0
      ? `${body}\n\n${residualGapsSection(residualForDisclosure)}`
      : body;

  const resolvedGaps = gapGateEnabled ? gaps : [];

  // Phase 5 — file (unless dryRun OR the cap routed to surface). D2: when
  // the cap routed to "surface" (CRITICAL remaining — the CRITICAL-only
  // terminal rule, #664 transposed), do NOT file — surface to the operator. D7: the filing failure is DISCRIMINATED and
  // carried on the result; the operator-visible text (plan-tool.ts) surfaces
  // the reason including the forge stderr, without requiring PI_ENSEMBLE_DEBUG.
  let issueUrl: string | undefined;
  let filingFailure: FilingFailure | undefined;
  // The cap-based skips set filingFailure REGARDLESS of dryRun: they are
  // policy, and the NOT-FILEABLE head + FILING STATUS must render on a dry
  // run too (hiding a halt behind dryRun is the #647 C1 defect).
  if (capReason === "review-unparseable") {
    // Fail closed: nothing was reviewed, so nothing files. The raw head
    // travels so parser-vs-prompt drift is diagnosable, never silent.
    filingFailure = {
      reason: "review-unparseable",
      detail: `the gap-gate review could not be parsed (no structured findings and no verdict, after one strict retry) — the spec was NOT reviewed and was not filed. Re-run start_plan_driver to retry the gate. Raw reviewer output head: ${rawUnparsedHead ?? "(unavailable)"}`,
    };
  } else if (capReason === "unresolved-blocking") {
    // Deliberate skip: CRITICAL gaps remain (CRITICAL-only blocks; HIGH
    // travels in the residual disclosure) — not filed by policy.
    filingFailure = {
      reason: "cap-surface",
      detail: "the gap gate cap routed to surface (CRITICAL gaps remain) — not filed by policy",
    };
  } else if (capReason === "gate-unavailable") {
    // Deliberate skip: the gate dispatch failed — no reviewer saw the spec.
    filingFailure = {
      reason: "gate-unavailable",
      detail:
        "the gap-gate dispatch failed — no reviewer ever saw the spec, so it was not filed (re-run start_plan_driver after the gate failure is addressed)",
    };
  } else if (!dryRun) {
    const fr = await timed("filing", () =>
      fileIssue(title, finalBody, getPlanForge() ?? (() => planForgeFor(repoRoot))),
    );
    issueUrl = fr.url;
    filingFailure = fr.failure;
  }

  // #633: report BOTH how many angles were dispatched and how many produced
  // structured items — `angles=` alone read as "3 angles ran" even when all
  // three returned prose-only (the all-angles-failed case the guard above
  // halts for now still surfaces the count when it fires).
  const structuredCount = findings.filter((f) => f.toolUses.length > 0).length;
  trace(
    `plan-driver: type=${type} angles=${findings.length} structured=${structuredCount} gaps=${gaps.length} filed=${!!issueUrl} dryRun=${!!dryRun} capReason=${capReason ?? "none"}`,
  );

  return {
    type,
    title,
    spec: finalBody,
    gaps: resolvedGaps,
    priorContext: priorContext.slice(0, 15),
    filed: !!issueUrl,
    issueUrl,
    capHit: capHit || undefined,
    capReason,
    residualForDisclosure: residualForDisclosure.length > 0 ? residualForDisclosure : undefined,
    filingFailure,
    failedAngles: failedAngles.length > 0 ? failedAngles : undefined,
    timings: finishTimings(),
  };
}

// Re-export for consumers that import from plan-driver.ts
export { classifyPlanType, planTitle } from "./plan-types.ts";
export { codeIdentifiersIn, draftSpec } from "./plan-draft.ts";

/**
 * Export seam for tests: `parseGaps` is module-private to the gap gate (the
 * driver runs it directly on the gate child's reply — the parsing logic now
 * lives in plan-gaps.ts). The smoke test reaches it through this alias.
 */
export function parseGapsForTest(reply: string) {
  return parseGaps(reply);
}
