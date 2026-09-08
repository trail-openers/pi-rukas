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
 *   Phase 1 Inventory  — vipune + `gh issue list` run by the driver; one
 *                        explore dispatch for duplicate risk
 *                        [plan-draft.ts: mechanicalInventory]
 *   Phase 2 Investigate — type-specialised explore set, all in parallel
 *                        [plan-draft.ts: anglePromptsFor]
 *   Phase 3 Draft      — the driver assembles the structured body
 *                        [plan-draft.ts: draftSpec]
 *   Phase 4 Gap gate   — one adversarial-developer dispatch per round;
 *                        CRITICAL/HIGH get ONE corrective round, then the
 *                        iteration cap ROUTES (D2, direct precedent: /work's
 *                        lens round cap): zero CRITICAL/HIGH remaining →
 *                        file with the residual MEDIUM/LOW gaps disclosed in
 *                        a "## Residual gap-gate findings" section;
 *                        CRITICAL or HIGH remain → do not file, surface to
 *                        the operator. The cap reason is a DISCRIMINATED
 *                        value (D1) so the operator-visible text names the
 *                        ACTUAL cause instead of claiming "unresolved
 *                        CRITICAL/HIGH gaps remain" when a MEDIUM-only
 *                        NEEDS_ITERATION verdict burned the iterations.
 *                        An ABSENT verdict with CRITICAL/HIGH gaps routes to
 *                        NEEDS_ITERATION (D3, verdictParsed — the adversarial
 *                        gate's #664 fix did the same).
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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dispatchCore } from "./dispatch.ts";
import {
  type AngleFindings,
  VIPUNE_PRECEDENCE_NOTE,
  VIPUNE_PRIOR_SOURCE,
  anglePromptsFor,
  codeIdentifiersIn,
  draftSpec,
  extractPlanItems,
  mechanicalInventory,
  parseOperatorDirectives,
  priorContextHasVipune,
  renderPriorContext,
} from "./plan-draft.ts";
import { type FilingFailure, fileIssue, getPlanForge, planForgeFor } from "./plan-filing.ts";

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
  type GapGateParse,
  capRouted,
  evaluateGapGate,
  parseGaps,
  residualGapsSection,
} from "./plan-gaps.ts";
import {
  type PlanDriverInput,
  type PlanGap,
  type PlanResult,
  classifyPlanType,
  planTitle,
} from "./plan-types.ts";
import { trace } from "./trace.ts";

const GAP_GATE_MAX_ITERATIONS = 2;

/**
 * Companion-extension path for the plan Phase-2 children (report_plan_item).
 * Follows LENS_REPORTER_PATH / POLICY_REPORTER_PATH exactly.
 */
const PLAN_REPORTER_PATH = `${__dirname}/plan-reporter.ts`;

/**
 * The extra args the Phase-2 investigation children run with: no skills
 * (the exploration tools are in the role prompt; skills would just add cost)
 * + the plan-reporter extension that registers report_plan_item.
 */
const PLAN_EXTRA_ARGS: string[] = ["--no-skills", "--extension", PLAN_REPORTER_PATH];

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
  const spec = `DRAFT SPEC:\n${body}\n\n`;
  const sum = `PHASE 2 FINDINGS SUMMARY:\n${summary}\n\n`;
  const prior =
    priorContext.length > 0
      ? `PM has already established these decisions and facts (DO NOT re-raise them as gaps; citing them is only valid if you can show the spec contradicts them):\n${renderPriorContext(priorContext)}\n${priorContextHasVipune(priorContext) ? `${VIPUNE_PRECEDENCE_NOTE}\n\n` : ""}`
      : "";
  const tail =
    "For each gap, output ONE line starting with the marker GAP: followed by the severity (CRITICAL: cannot proceed; HIGH: implementer will be confused or wrong; MEDIUM: nice-to-have clarification; LOW: cosmetic), an em dash, a short description, then — proposed resolution: with the proposed resolution. Example: GAP: CRITICAL — no failure-mode acceptance criterion — proposed resolution: add a criterion for the retry path. Never write a severity word on its own line — prose mentioning CRITICAL/HIGH/MEDIUM/LOW does not create a gap unless the line starts with GAP:. Each resolution must be ONE of: (a) an additional research dispatch, (b) a sharper acceptance criterion to add, or (c) an Open Question. End your reply with a single line exactly of the form:\nVERDICT: READY  (zero CRITICAL/HIGH gaps)\nor\nVERDICT: NEEDS_ITERATION";
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

  // Phase 1
  const inv = await mechanicalInventory(repoRoot, descriptor);
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

  // Phase 1b — duplicate-risk discovery. The mechanical inventory is only a
  // mechanical scan: it cannot see semantic overlap a different title hides,
  // so the risk call always goes to an explore (the one Phase-1 dispatch the
  // prose flow defined).
  let duplicateRisk: { level: string; rationale: string } | undefined;
  {
    const dup = await dispatch(
      pi,
      {
        role: "explore",
        prompt: [
          `DUPLICATE RISK CHECK for a proposed ${type} ticket: "${descriptor}".`,
          `Mechanical scan found: ${
            inv.related.map((r) => `#${r.number} (${r.state}) ${r.title}`).join("; ") ||
            "no related issues"
          }.`,
          "Assess whether filing this ticket would duplicate existing work — check open + recently closed issues (gh issue list --state all --search '<keyword>' --limit 10) and vipune.",
          "Return a short verdict: DUPLICATE_RISK: high|medium|low|none plus 2-3 sentences of rationale with issue numbers.",
        ].join(" "),
      },
      { label: "plan-duplicate-risk" },
    );
    if (dup.ok) {
      const m = dup.text.match(/DUPLICATE_RISK\s*[:—-]\s*(high|medium|low|none)/i);
      duplicateRisk = {
        level: m ? (m[1] ?? "medium").toLowerCase() : "medium",
        rationale: dup.text.slice(0, 400),
      };
      trace(`plan-driver: duplicateRisk=${duplicateRisk.level}`);
    }
  }

  if (duplicateRisk && duplicateRisk.level === "high") {
    throw new Error(
      `duplicate risk HIGH — the inventory shows likely duplicate work (${duplicateRisk.rationale.slice(0, 200)}). Do not file; reconcile with the existing issue(s) first.`,
    );
  }

  // Phase 2 — the children run with the plan-reporter extension (the
  // report_plan_item tool) so the driver reads structured items from
  // result.toolUses instead of line-splitting prose. The duplicate-risk
  // child and the gap-gate child do NOT get the reporter — they return a
  // single marker-line reply, not a list of items.
  const codeIds = codeIdentifiersIn(descriptor);
  const angles = anglePromptsFor(type, descriptor, priorContext, codeIds);
  const findings: AngleFindings[] = await Promise.all(
    angles.map((a) =>
      dispatch(
        pi,
        { role: "explore", prompt: a.prompt },
        { label: `plan-${a.name}`.slice(0, 24), extraArgs: PLAN_EXTRA_ARGS },
      ).then((r) => {
        const toolUses = r.toolUses; // #633: DispatchResult declares toolUses: unknown[] (non-optional) — the ?? [] guarded nothing
        // Structured-first (D8, fail-closed): an angle is "ok" only when the
        // dispatch succeeded AND it produced at least one structured item. An
        // angle that returned prose-only contributed nothing to the typed
        // sections — its summary may still show in Technical context as a
        // fallback, but it does not count as a completed angle.
        const ok = r.ok && !r.errorStop && toolUses.length > 0;
        return {
          name: a.name,
          ok,
          text: r.text,
          toolUses: extractPlanItems(toolUses, a.name),
        };
      }),
    ),
  );

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
  );

  // Phase 4 — gap gate (mandatory except chore/spike + escape hatch).
  // The cap ROUTES (D2): zero CRITICAL/HIGH remaining at the cap → file
  // with the residual MEDIUM/LOW disclosed; CRITICAL/HIGH remain → surface.
  // The cap reason is DISCRIMINATED (D1): the operator-visible text names
  // the ACTUAL cause instead of claiming "unresolved CRITICAL/HIGH gaps
  // remain" when a MEDIUM-only NEEDS_ITERATION verdict burned the rounds.
  const gapGateEnabled = !(
    (type === "chore" || type === "spike") &&
    process.env.PI_ENSEMBLE_PLAN_GAP_GATE === "0"
  );
  let gaps: PlanGap[] = [];
  let capHit = false;
  let capReason: PlanResult["capReason"];
  let residualForDisclosure: PlanGap[] = [];
  let lastParse: GapGateParse | undefined;

  if (gapGateEnabled) {
    let iterations = 0;
    let ready = false;
    while (iterations < GAP_GATE_MAX_ITERATIONS && !ready) {
      iterations++;
      const gate = await dispatch(
        pi,
        { role: "adversarial-developer", prompt: gapGatePrompt(body, findings, priorContext) },
        { label: `plan-gap-gate-${iterations}` },
      );
      if (!gate.ok || gate.errorStop) {
        // The gate never ran. We cannot assert a spec is clean when nothing
        // reviewed it — this is the same failure class D3 closes for an
        // absent verdict, two branches away ("gate never ran → pass" instead
        // of "verdict absent → pass"). Do NOT file: set capHit + the
        // discriminated capReason and surface to the operator with the gate's
        // failure reason, matching the all-angles-failed halt (which bails
        // before draftSpec for the same reason) and the cap-surface shape.
        trace(
          `plan-driver: gap gate dispatch failed (iteration ${iterations}) — gate unavailable, not filing`,
        );
        capHit = true;
        capReason = "gate-unavailable";
        break;
      }
      lastParse = parseGaps(gate.text);
      gaps = lastParse.gaps;
      const evald = evaluateGapGate(lastParse, iterations, GAP_GATE_MAX_ITERATIONS);
      ready = evald.ready;
      if (!ready && evald.corrective) {
        for (const g of evald.blocking) {
          // Bug 3 (#606): gaps from this round are carried into the re-draft
          // with the reviewer's proposed resolution attached and tagged so
          // draftSpec renders them as `status: resolved` (the spec now states
          // the decision, re-reviewed next round), not the old hard-coded
          // `status: pending`.
          g.status = "resolved";
          openQuestions.push(`resolved: ${g.description} — proposed resolution: ${g.resolution}`);
        }
        ({ title, body } = draftSpec(
          type,
          descriptor,
          findings,
          priorContext,
          openQuestions,
          outOfScope,
          depth,
          directives,
        ));
      } else if (!ready) {
        capHit = true;
        // D2 + D1: at the cap, the routing policy (plan-gaps.ts: capRouted)
        // decides file-vs-surface, and the REASON is discriminated so the
        // operator-visible text names the ACTUAL cause.
        const route = capRouted(evald.blocking);
        capReason = route === "file" ? "residual-medium-low" : "unresolved-blocking";
        if (route === "file") {
          residualForDisclosure = gaps;
        }
      }
    }
    // D3: an ABSENT verdict with only MEDIUM/LOW gaps records that the
    // verdict was missing so it can be surfaced (READY is acceptable for
    // MEDIUM/LOW-only — but the operator should know the gate did not
    // explicitly say so).
    if (lastParse && !lastParse.verdictParsed && !capHit) {
      capReason = "verdict-absent";
    }
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
  // the cap routed to "surface" (CRITICAL/HIGH remaining), do NOT file —
  // surface to the operator. D7: the filing failure is DISCRIMINATED and
  // carried on the result; the operator-visible text (plan-tool.ts) surfaces
  // the reason including the forge stderr, without requiring PI_ENSEMBLE_DEBUG.
  let issueUrl: string | undefined;
  let filingFailure: FilingFailure | undefined;
  if (!dryRun && capReason !== "unresolved-blocking" && capReason !== "gate-unavailable") {
    const fr = await fileIssue(title, finalBody, getPlanForge() ?? (() => planForgeFor(repoRoot)));
    issueUrl = fr.url;
    filingFailure = fr.failure;
  } else if (!dryRun && capReason === "unresolved-blocking") {
    // Deliberate skip, not a failure: the gap-gate cap routed to surface
    // (CRITICAL/HIGH gaps remain), so the spec is NOT filed by policy.
    // Its own reason — nothing failed to resolve here.
    filingFailure = {
      reason: "cap-surface",
      detail:
        "the gap gate cap routed to surface (CRITICAL/HIGH gaps remain) — not filed by policy",
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
    filingFailure,
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
