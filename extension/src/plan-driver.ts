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
 * Phase compilation (mechanical vs dispatched):
 *
 *   Phase 0 Classify   — regex on the descriptor (or the `type` param)
 *                        [plan-types.ts]
 *   Phase 1 Inventory  — vipune + `gh issue list` run by the driver
 *                        [plan-draft.ts: mechanicalInventory]
 *   Phase 1b+2 Investigate — the duplicate-risk explore AND the
 *                        type-specialised angle set dispatch as ONE parallel
 *                        barrier (the duplicate check used to serially block
 *                        the fan-out for a result consumed only as a
 *                        HIGH/not-HIGH boolean); the HIGH-risk hard stop
 *                        applies after the barrier, before draft/gate/file
 *                        [plan-investigate.ts: runInvestigation]
 *   Phase 3 Draft      — the driver assembles the structured body
 *                        [plan-draft.ts: draftSpec]
 *   Phase 4 Gap gate   — one adversarial-developer dispatch per round;
 *                        CRITICAL-only terminal rule (#664 transposed):
 *                        CRITICAL gets ONE corrective round, HIGH no longer
 *                        triggers re-drafting (the gate is non-deterministic
 *                        on identical input — "fix the gaps and re-run" is
 *                        not convergent). The cap ROUTES (D2): zero CRITICAL
 *                        remaining → file with residual HIGH/MEDIUM/LOW
 *                        disclosed in the existing "## Residual gap-gate
 *                        findings" section; CRITICAL remains → surface.
 *                        Cap reason is DISCRIMINATED (D1): residual-high /
 *                        residual-medium-low both route to file; unresolved-
 *                        blocking means CRITICAL remains. ABSENT verdict with
 *                        CRITICAL → NEEDS_ITERATION (D3, verdictParsed).
 *                        PI_ENSEMBLE_PLAN_GAP_GATE=0 skips for chore/spike.
 *   Phase 5 File       — the forge adapter's issueCreate (child process,
 *                        exempt from the tool_call guard by construction,
 *                        exactly like work-driver-commit's `gh pr create`).
 *                        A filing failure carries a DISCRIMINATED reason on
 *                        the result (D7) — forge-unresolved, create-error
 *                        (with the forge stderr), empty-url — plus the
 *                        deliberate-skip case for the all-angles-failed halt.
 *
 * dryRun is the confirmation seam: `dryRun: true` returns the spec + gaps
 * without filing; PM shows it to the operator; on confirmation the driver
 * is re-called with `dryRun` omitted.
 *
 * Every phase is timed (PlanResult.timings) — the operator's 20–30-minute
 * report was structural inference until now; per-phase durations turn the
 * cost debate into measurement (research next-step #1,
 * outputs/spec-driven-plan-driver-gap.md §7).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dispatchCore } from "./dispatch.ts";
import {
  type AngleFindings,
  VIPUNE_PRECEDENCE_NOTE,
  VIPUNE_PRIOR_SOURCE,
  codeIdentifiersIn,
  draftSpec,
  mechanicalInventory,
  parseOperatorDirectives,
  priorContextHasVipune,
  renderPriorContext,
} from "./plan-draft.ts";
import { type FilingFailure, fileIssue, getPlanForge, planForgeFor } from "./plan-filing.ts";
import {
  PLAN_DISPATCH_TIMEOUT_MS,
  PLAN_MARKER_CHILD_ARGS,
  runInvestigation,
} from "./plan-investigate.ts";

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
import { DESCRIPTOR_DATA_FRAMING } from "./plan-angles.ts";
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

// ---------------------------------------------------------------------------
// Phase 4 — adversarial gap gate (parsing + routing in plan-gaps.ts)
// ---------------------------------------------------------------------------

/**
 * The gap-gate reviewer prompt. Carries the prior context (capped at the
 * render site via renderPriorContext — #633: the gate child is one reviewer,
 * the filed body carries the full uncapped inventory) and — since the vipune
 * tag (D6) — the explicit precedence note whenever any prior entry is
 * vipune-sourced: a vipune entry is a prior snapshot and may be stale.
 */
export function gapGatePrompt(
  body: string,
  findings: AngleFindings[],
  priorContext: { source: string; fact: string }[],
): string {
  const summary = findings
    .map((x) => {
      const n = x.toolUses.filter((i) => typeof i === "object").length;
      return `- ${x.name}: ${x.ok ? (n > 0 ? `ran (${n} structured item${n === 1 ? "" : "s"})` : "ran (no structured items)") : "skipped/failed"}`;
    })
    .join("\n");
  const head =
    "GAP DETECTION: review this draft spec and find what is missing, under-specified, ambiguous or unverifiable.\n\n";
  // PR #640 SECURITY: descriptor interpolated verbatim; prompt-level mitigation only, not a boundary.
  const spec = `${DESCRIPTOR_DATA_FRAMING}DRAFT SPEC:\n${body}\n\n`;
  const sum = `PHASE 2 FINDINGS SUMMARY:\n${summary}\n\n`;
  const prior =
    priorContext.length > 0
      ? `PM has already established these decisions and facts (DO NOT re-raise them as gaps; citing them is only valid if you can show the spec contradicts them):\n${renderPriorContext(priorContext)}\n${priorContextHasVipune(priorContext) ? `${VIPUNE_PRECEDENCE_NOTE}\n\n` : ""}`
      : "";
  const tail =
    "Severity is keyed to WHO must decide. For each gap, output ONE line starting with the marker GAP: followed by the severity, an em dash, a short description, then — proposed resolution: with the proposed resolution. The severity scale:\n" +
    "CRITICAL: the spec commits to two things that contradict, or the stated approach cannot work — building from it produces WRONG behaviour\n" +
    "HIGH: a decision the operator must make because the implementer cannot — a scope boundary, a policy, or a choice between designs with different consequences\n" +
    "MEDIUM: a clarification that changes how the work is organised, not what gets built\n" +
    "LOW: cosmetic\n\n" +
    "Scope Discipline. Do NOT file a gap, at ANY severity, for:\n" +
    "- a value or constant the implementer will pick (resolved against live code during /work)\n" +
    "- an exact API or method signature (the implementer reads the current code)\n" +
    "- an error type or error shape (same: the existing types say it)\n" +
    "- a field list derivable from an existing type\n" +
    "- a test-harness mechanic (mock flags, grep needles, variable usage)\n" +
    "- exact line numbers anywhere (they rot; name the SYMBOL)\n" +
    "- restating a decision the spec already makes once\n\n" +
    "Example: GAP: CRITICAL — the spec commits to both a retry cap of 3 and an infinite retry on quota errors — proposed resolution: name which wins. Never write a severity word on its own line — prose mentioning CRITICAL/HIGH/MEDIUM/LOW does not create a gap unless the line starts with GAP:. Each resolution must be ONE of: (a) an additional research dispatch, (b) a sharper acceptance criterion to add, or (c) an Open Question. End your reply with a single line exactly of the form:\nVERDICT: READY  (zero CRITICAL gaps)\nor\nVERDICT: NEEDS_ITERATION";
  return `${head}${spec}${sum}${prior}${tail}`;
}

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

  // Phase 1
  const inv = await timed("inventory", () => mechanicalInventory(repoRoot, descriptor));
  const priorContext: { source: string; fact: string }[] = [
    // D6: vipune hits are tagged distinctly — they are snapshots saved
    // during a PREVIOUS planning run and may be stale (the blocked-session
    // feedback loop; transcript mtsnbz8b). The precedence note in the
    // angle/gap-gate prompts (VIPUNE_PRECEDENCE_NOTE) makes the live
    // context-param entries and live code win on conflict.
    ...inv.memory.map((h) => ({ source: VIPUNE_PRIOR_SOURCE, fact: h.content.slice(0, 200) })),
    ...inv.related
      .slice(0, 5)
      .map((r) => ({ source: `issue #${r.number} (${r.state})`, fact: r.title })),
  ];
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

  // Phase 1b + Phase 2 — ONE parallel barrier (plan-investigate.ts): the
  // duplicate-risk explore and the type-specialised angle set dispatch
  // together; wall clock is the slowest child, not their sum. The HIGH-risk
  // hard stop applies AFTER the barrier — semantics unchanged (a HIGH
  // verdict still refuses to file); the only trade is that on HIGH the
  // angle tokens are already spent, and HIGH is the rare case.
  const codeIds = codeIdentifiersIn(descriptor);
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
      }),
    );

  if (duplicateRisk && duplicateRisk.level === "high") {
    throw new Error(
      `duplicate risk HIGH — the inventory shows likely duplicate work (${duplicateRisk.rationale.slice(0, 200)}). Do not file; reconcile with the existing issue(s) first.`,
    );
  }

  // #633 aggregate all-angles-failed guard (fail-closed): each angle fails
  // closed individually (ok requires toolUses.length > 0), but if EVERY
  // dispatched angle produced zero structured items — all prose-only or
  // schema-invalid calls — every typed section silently falls back and the
  // pipeline would file a ticket reading "(decomposition not available)" /
  // "none" with fallback strings everywhere (the epics with the gap gate off
  // by default were the worst case). Halt before draftSpec/fileIssue instead;
  // the operator sees WHY (all angles returned prose-only or schema-invalid
  // calls), not an empty spec. D7: the early return carries the
  // `skipped-all-angles-failed` reason so the operator-visible text can say
  // "filing was deliberately skipped" rather than "filing failed".
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

  // Phase 4 — gap gate (mandatory except chore/spike + escape hatch).
  // CRITICAL-only terminal rule (#664 transposed): the cap ROUTES (D2):
  // zero CRITICAL → file with residual disclosed; CRITICAL remains →
  // surface. Cap reason DISCRIMINATED (D1): residual-high / residual-
  // medium-low both route to file; unresolved-blocking means CRITICAL.
  const gapGateEnabled = !(
    (type === "chore" || type === "spike") &&
    process.env.PI_ENSEMBLE_PLAN_GAP_GATE === "0"
  );
  let gaps: PlanGap[] = [];
  let capHit = false;
  let capReason: PlanResult["capReason"];
  let residualForDisclosure: PlanGap[] = [];

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
        // pinned to the repo root, the 8-min timeout instead of the 2-hour
        // backstop, and --no-skills (a marker-line reviewer, no reporter).
        (spec, opts) =>
          dispatch(
            pi,
            { ...spec, cwd: repoRoot },
            { ...opts, timeoutMs: PLAN_DISPATCH_TIMEOUT_MS, extraArgs: PLAN_MARKER_CHILD_ARGS },
          ),
        () => gapGatePrompt(body, findings, priorContext),
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
  if (!dryRun && capReason !== "unresolved-blocking" && capReason !== "gate-unavailable") {
    const fr = await timed("filing", () =>
      fileIssue(title, finalBody, getPlanForge() ?? (() => planForgeFor(repoRoot))),
    );
    issueUrl = fr.url;
    filingFailure = fr.failure;
  } else if (!dryRun && capReason === "unresolved-blocking") {
    // Deliberate skip, not a failure: the gap-gate cap routed to surface
    // (CRITICAL gaps remain — CRITICAL-only blocks; HIGH findings travel
    // in the residual disclosure instead), so the spec is NOT filed by
    // policy. Its own reason — nothing failed to resolve here.
    filingFailure = {
      reason: "cap-surface",
      detail: "the gap gate cap routed to surface (CRITICAL gaps remain) — not filed by policy",
    };
  } else if (!dryRun && capReason === "gate-unavailable") {
    // Deliberate skip, not a filing failure: the gap-gate dispatch itself
    // failed, so NO REVIEWER EVER SAW THE SPEC. The spec is not filed because
    // we cannot assert it is clean — the same posture as all-angles-failed
    // (which bails before draftSpec for the same reason) and D3 (an absent
    // verdict must not silently pass). Its own reason: the gap gate was
    // unavailable; the operator re-runs start_plan_driver after the cause is
    // addressed (the spec above is still valid to review).
    filingFailure = {
      reason: "gate-unavailable",
      detail:
        "the gap-gate dispatch failed — no reviewer ever saw the spec, so it was not filed (re-run start_plan_driver after the gate failure is addressed)",
    };
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
