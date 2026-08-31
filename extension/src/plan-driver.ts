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
 *   Phase 4 Gap gate   — one adversarial-developer dispatch; CRITICAL/HIGH
 *                        get ONE corrective round, then the cap is hit and
 *                        the residual gaps travel with the spec.
 *                        PI_ENSEMBLE_PLAN_GAP_GATE=0 skips for chore/spike.
 *   Phase 5 File       — `gh issue create --body-file` via execp (child
 *                        process, exempt from the tool_call guard by
 *                        construction, exactly like work-driver-commit's
 *                        `gh pr create`).
 *
 * dryRun is the confirmation seam: `dryRun: true` returns the spec + gaps
 * without filing; PM shows it to the operator; on confirmation the driver
 * is re-called with `dryRun` omitted.
 */

import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dispatchCore } from "./dispatch.ts";
import {
  type AngleFindings,
  anglePromptsFor,
  codeIdentifiersIn,
  draftSpec,
  mechanicalInventory,
} from "./plan-draft.ts";
import {
  type PlanDriverInput,
  type PlanGap,
  type PlanResult,
  type PlanType,
  classifyPlanType,
  planTitle,
} from "./plan-types.ts";
import { trace } from "./trace.ts";

const execp = promisify(exec);
const GAP_GATE_MAX_ITERATIONS = 2;

// ---------------------------------------------------------------------------
// Phase 4 — adversarial gap gate
// ---------------------------------------------------------------------------

function gapGatePrompt(body: string, findings: AngleFindings[]): string {
  const summary = findings.map((x) => `- ${x.name}: ${x.ok ? "ran" : "skipped/failed"}`).join("\n");
  const head =
    "GAP DETECTION: review this draft spec and find what is missing, under-specified, ambiguous or unverifiable.\n\n";
  const spec = `DRAFT SPEC:\n${body}\n\n`;
  const sum = `PHASE 2 FINDINGS SUMMARY:\n${summary}\n\n`;
  const tail =
    "For each gap, classify severity (CRITICAL: cannot proceed; HIGH: implementer will be confused or wrong; MEDIUM: nice-to-have clarification; LOW: cosmetic) and propose ONE resolution: (a) an additional research dispatch, (b) a sharper acceptance criterion to add, or (c) an Open Question. End your reply with a single line exactly of the form:\nVERDICT: READY  (zero CRITICAL/HIGH gaps)\nor\nVERDICT: NEEDS_ITERATION";
  return `${head}${spec}${sum}${tail}`;
}

function parseGaps(reply: string): { gaps: PlanGap[]; verdict: "READY" | "NEEDS_ITERATION" } {
  const lines = reply.split("\n");
  const gaps: PlanGap[] = [];
  const severityRe = /\b(CRITICAL|HIGH|MEDIUM|LOW)\b/i;
  for (const line of lines) {
    const m = line.match(severityRe);
    const text = line.replace(/^[-*\d.)\s]+/, "").trim();
    if (m && text.length > 12 && !/verdict/i.test(line)) {
      gaps.push({
        severity: (m[1] ?? "MEDIUM").toUpperCase() as PlanGap["severity"],
        description: text.slice(0, 300),
        resolution: "address during /work plan phase",
      });
    }
  }
  const verdictLine = [...lines].reverse().find((l) => /verdict\s*[:—-]/i.test(l)) ?? "";
  const verdict: "READY" | "NEEDS_ITERATION" = /needs[_ ]iteration/i.test(verdictLine)
    ? "NEEDS_ITERATION"
    : "READY";
  if (gaps.length === 0) {
    return {
      gaps: [
        { severity: "MEDIUM", description: "no structured gaps parsed", resolution: "proceed" },
      ],
      verdict,
    };
  }
  return { gaps, verdict };
}

// ---------------------------------------------------------------------------
// Phase 5 — filing
// ---------------------------------------------------------------------------

async function fileIssue(
  repoRoot: string,
  title: string,
  body: string,
): Promise<string | undefined> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-ensemble-plan-"));
  const bodyFile = path.join(dir, "body.md");
  try {
    await writeFile(bodyFile, body);
    const { stdout } = await execp(
      `gh issue create --title ${JSON.stringify(title)} --body-file ${JSON.stringify(bodyFile)}`,
      { cwd: repoRoot, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  } catch (err) {
    trace(`plan-driver: gh issue create failed: ${(err as Error).message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// runPlanPipeline
// ---------------------------------------------------------------------------

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
    ...inv.memory.map((h) => ({ source: "vipune", fact: h.content.slice(0, 200) })),
    ...inv.related
      .slice(0, 5)
      .map((r) => ({ source: `issue #${r.number} (${r.state})`, fact: r.title })),
  ];
  if (context && context.trim().length > 0) {
    for (const line of context.trim().split("\n")) {
      if (line.trim())
        priorContext.push({ source: "context param", fact: line.trim().slice(0, 200) });
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

  // Phase 2
  const codeIds = codeIdentifiersIn(descriptor);
  const angles = anglePromptsFor(type, descriptor, priorContext, codeIds);
  const findings: AngleFindings[] = await Promise.all(
    angles.map((a) =>
      dispatch(
        pi,
        { role: "explore", prompt: a.prompt },
        { label: `plan-${a.name}`.slice(0, 24) },
      ).then((r) => ({ name: a.name, ok: r.ok && !r.errorStop, text: r.text })),
    ),
  );

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
  );

  // Phase 4 — gap gate (mandatory except chore/spike + escape hatch)
  const gapGateEnabled = !(
    (type === "chore" || type === "spike") &&
    process.env.PI_ENSEMBLE_PLAN_GAP_GATE === "0"
  );
  let gaps: PlanGap[] = [];
  let capHit = false;

  if (gapGateEnabled) {
    let iterations = 0;
    let ready = false;
    while (iterations < GAP_GATE_MAX_ITERATIONS && !ready) {
      iterations++;
      const gate = await dispatch(
        pi,
        { role: "adversarial-developer", prompt: gapGatePrompt(body, findings) },
        { label: `plan-gap-gate-${iterations}` },
      );
      if (!gate.ok || gate.errorStop) {
        trace(
          `plan-driver: gap gate dispatch failed (iteration ${iterations}); proceeding with unresolved gate`,
        );
        break;
      }
      const parsed = parseGaps(gate.text);
      gaps = parsed.gaps;
      const blocking = gaps.filter((g) => g.severity === "CRITICAL" || g.severity === "HIGH");
      ready = parsed.verdict === "READY" && blocking.length === 0;
      if (!ready && iterations < GAP_GATE_MAX_ITERATIONS) {
        for (const g of blocking) {
          openQuestions.push(`${g.description} — proposed resolution: ${g.resolution}`);
        }
        ({ title, body } = draftSpec(
          type,
          descriptor,
          findings,
          priorContext,
          openQuestions,
          outOfScope,
          depth,
        ));
      } else if (!ready) {
        capHit = true;
      }
    }
  }

  const resolvedGaps = gapGateEnabled ? gaps : [];

  // Phase 5
  let issueUrl: string | undefined;
  if (!dryRun) {
    issueUrl = await fileIssue(repoRoot, title, body);
  }

  trace(
    `plan-driver: type=${type} angles=${findings.length} gaps=${gaps.length} filed=${!!issueUrl} dryRun=${!!dryRun}`,
  );

  return {
    type,
    title,
    spec: body,
    gaps: resolvedGaps,
    priorContext: priorContext.slice(0, 15),
    filed: !!issueUrl,
    issueUrl,
    capHit: capHit || undefined,
  };
}

// Re-export for consumers that import from plan-driver.ts
export { classifyPlanType, planTitle } from "./plan-types.ts";
export { codeIdentifiersIn, draftSpec } from "./plan-draft.ts";
