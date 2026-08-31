/**
 * plan-draft — phases 1-3 of the compiled /plan pipeline.
 *
 * Phase 1: mechanical inventory (vipune + `gh issue list`).
 * Phase 2: type-specialised investigation angles (parallel explore).
 * Phase 3: draft synthesis (the driver assembles the structured body).
 *
 * Split out of plan-driver.ts to keep each module under the 500-line hard
 * limit (AGENTS.md §12). Phase 0 (classify) lives in plan-types.ts; phases
 * 4-5 (gap gate + filing) + the orchestrator live in plan-driver.ts.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { EPIC_SUB_ISSUE_DEPTH_LIMIT, type PlanType, planTitle } from "./plan-types.ts";
import type { MemoryHit } from "./vipune.ts";
import { vipuneSearch } from "./vipune.ts";

const execp = promisify(exec);

// ---------------------------------------------------------------------------
// Phase 1 — mechanical inventory
// ---------------------------------------------------------------------------

/**
 * Extract the concrete code identifiers the descriptor names (file names,
 * dotted/qualified symbols). Phase 2's code prior-art leg runs only when
 * the descriptor actually names code — a meta descriptor should not burn a
 * code search.
 */
export function codeIdentifiersIn(descriptor: string): string[] {
  const out = new Set<string>();
  const fileRe = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|rs|go|py|rb|sh|json|ya?ml|toml)\b/g;
  const symbolRe = /\b[a-z][a-zA-Z0-9]*(?:[./][a-zA-Z0-9_]+)+\b/g;
  for (const m of descriptor.matchAll(fileRe)) if (m[0]) out.add(m[0]);
  for (const m of descriptor.matchAll(symbolRe)) if (m[0] && m[0].length >= 6) out.add(m[0]);
  return [...out].slice(0, 5);
}

export interface MechanicalInventory {
  memory: MemoryHit[];
  related: { number: number; title: string; state: string }[];
  errors: string[];
}

export async function mechanicalInventory(
  repoRoot: string,
  descriptor: string,
): Promise<MechanicalInventory> {
  const keywords = descriptor
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^(the|and|with|from|into|that|this|which|when)\b/i.test(w))
    .slice(0, 4);
  const terms = keywords.length > 0 ? keywords.join(" ") : descriptor.slice(0, 60);

  const res = await vipuneSearch(terms, { cwd: repoRoot, limit: 5 });
  const memory = res.kind === "hits" ? res.hits : [];

  const related: MechanicalInventory["related"] = [];
  const errors: string[] = [];
  try {
    const { stdout } = await execp(
      `gh issue list --search '${terms.replace(/'/g, "")}' --state all --limit 10 --json number,title,state`,
      { cwd: repoRoot, maxBuffer: 1024 * 1024 },
    );
    const rows = JSON.parse(stdout) as Array<{ number: number; title: string; state: string }>;
    for (const r of rows) related.push({ number: r.number, title: r.title, state: r.state });
  } catch (err) {
    errors.push(`gh issue list: ${(err as Error).message.split("\n")[0]}`);
  }
  return { memory, related, errors };
}

// ---------------------------------------------------------------------------
// Phase 2 — type-specialised investigation (parallel explore)
// ---------------------------------------------------------------------------

export interface Angle {
  name: string;
  /** undefined angle prompt = the angle is conditional; decided per run. */
  build: (ctx: {
    type: PlanType;
    descriptor: string;
    priorContext: { source: string; fact: string }[];
    codeIdentifiers: string[];
  }) => string | undefined;
}

const ANGLES: Record<PlanType, Angle[]> = {
  bug: [
    {
      name: "reproduction-surface",
      build: ({ descriptor }) =>
        `Determine concrete steps to reproduce this bug: "${descriptor}". Find: the error messages and logs relevant to it (codebase_memory_search_code + git log), environment specifics that matter, flakiness factors, and the existing test cases that should have caught it. Return findings + evidence + confidence + gaps.`,
    },
    {
      name: "affected-code",
      build: ({ descriptor }) =>
        `Identify the files, functions and call sites affected by this bug: "${descriptor}". For each, capture exact path:line, the function/component name, and why it is in-scope. Use codebase_memory_search_code. Return affected[] + references + gaps.`,
    },
    {
      name: "test-surface",
      build: ({ descriptor }) =>
        `Catalogue the existing tests near the work area for this bug: "${descriptor}". List file paths + key test names to extend or that are missing, golden-fixture candidates, and coverage gaps the fix should close. Return existingTests[] + goldenFixtureCandidates[] + coverageGaps[].`,
    },
  ],
  feature: [
    {
      name: "prior-art",
      build: ({ descriptor, codeIdentifiers }) => {
        if (codeIdentifiers.length === 0) return undefined;
        return `Look for prior art for this feature: "${descriptor}". Check existing implementations and patterns with codebase_memory_search_code (candidate identifiers: ${codeIdentifiers.join(", ")}). Return priorArt[] (source, summary, reuse opportunity) + conventions[] + gaps.`;
      },
    },
    {
      name: "interfaces-and-contracts",
      build: ({ descriptor, codeIdentifiers }) => {
        if (codeIdentifiers.length === 0) return undefined;
        return `Map the type contracts, data shapes and API boundaries this feature touches: "${descriptor}". Function signatures to implement or conform to, structures passed in/out, external contracts. Candidate identifiers: ${codeIdentifiers.join(", ")}. Include typed references where possible (path/file.ts:NN — exported interface X). Return contracts[] + dataShapes[] + references (file paths, no colons).`;
      },
    },
    {
      name: "test-surface",
      build: ({ descriptor }) =>
        `Catalogue the existing tests near the work area for this feature: "${descriptor}". File paths + key test names to extend, golden-fixture candidates, coverage gaps to close. Return existingTests[] + goldenFixtureCandidates[] + coverageGaps[].`,
    },
  ],
  epic: [
    {
      name: "decomposition-surface",
      build: ({ descriptor }) =>
        `Break this epic into natural sub-issues: "${descriptor}". For each: a title proposal, a brief scope, dependencies on other sub-issues, and a suggested ordering. Return subIssues[] (title, scope, deps, order).`,
    },
    {
      name: "success-criteria",
      build: ({ descriptor }) =>
        `How do we know this epic is done? "${descriptor}". Outcome metrics, user-visible behaviour, technical milestones. Return criteria[] (type, description, measurement).`,
    },
  ],
  chore: [
    {
      name: "scope-validation",
      build: ({ descriptor }) =>
        `Is this actually a chore vs a feature/bug in disguise? "${descriptor}". What is the smallest viable change? What scope-creep risks exist that should be split into separate tickets? Return isChore + smallestViableChange + scopeCreepRisks[].`,
    },
    {
      name: "affected-files",
      build: ({ descriptor }) =>
        `List the files this chore will touch: "${descriptor}". For each: path + change type (rename/refactor/delete/config-bump). Return affected[].`,
    },
  ],
  spike: [
    {
      name: "scoping",
      build: ({ descriptor }) =>
        `Scope this spike: "${descriptor}". What is the time-box, the expected deliverable (a decision, prototype or write-up — NOT shipped code), and the success criteria? Return timebox + deliverable + successCriteria.`,
    },
  ],
};

export function anglePromptsFor(
  type: PlanType,
  descriptor: string,
  priorContext: { source: string; fact: string }[],
  codeIdentifiers: string[],
): { name: string; prompt: string }[] {
  return ANGLES[type]
    .map((a) => ({
      name: a.name,
      prompt: buildAnglePrompt(a, type, descriptor, priorContext, codeIdentifiers),
    }))
    .filter((x) => x.prompt !== undefined)
    .map((x) => ({ name: x.name, prompt: x.prompt as string }));
}

function buildAnglePrompt(
  angle: Angle,
  type: PlanType,
  descriptor: string,
  priorContext: { source: string; fact: string }[],
  codeIdentifiers: string[],
): string | undefined {
  const task = angle.build({ type, descriptor, priorContext, codeIdentifiers });
  if (!task) return undefined;
  const prior =
    priorContext.length > 0
      ? `PM has already established (DO NOT re-investigate):\n${priorContext
          .map((p) => `- [${p.source}] ${p.fact}`)
          .join("\n")}\n\n`
      : "";
  const taskLine = `INVESTIGATION (angle: ${angle.name}, ticket type: ${type})\n\n${prior}${task}\n\n`;
  return `${taskLine}Be compact: return your findings as a tight bulleted list of the facts you confirmed, with file:line evidence where you have it. No preamble.`;
}

// ---------------------------------------------------------------------------
// Phase 3 — draft synthesis (driver assembles the body)
// ---------------------------------------------------------------------------

export interface AngleFindings {
  name: string;
  ok: boolean;
  text: string;
}

function sectionBullets(items: string[], fallback: string): string {
  const clean = items.filter((s) => s.trim().length > 0);
  return clean.length > 0 ? clean.map((s) => `- ${s}`).join("\n") : `- ${fallback}`;
}

function extractLines(findings: AngleFindings, minLen = 8): string[] {
  if (!findings.ok) return [];
  return findings.text
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length >= minLen && !/^(output|return|use|note:)/i.test(l));
}

function epicSubIssues(findings: AngleFindings[]): string[] {
  const decompose = findings.find((f) => f.name === "decomposition-surface" && f.ok);
  const lines = decompose ? extractLines(decompose, 6) : [];
  return lines.map((l, i) => `- [ ] #N — ${l} (sub-issue ${i + 1})`);
}

const DEPTH_LIMIT_NOTE =
  "- spec depth limit reached — run start_plan_driver with this descriptor for the full spec";

export function draftSpec(
  type: PlanType,
  descriptor: string,
  findings: AngleFindings[],
  priorContext: { source: string; fact: string }[],
  openQuestions: string[],
  outOfScope: string[],
  depth: number,
): { title: string; body: string } {
  const title = planTitle(descriptor, type);

  const ctx = sectionBullets(
    priorContext.slice(0, 8).map((p) => `${p.fact} [${p.source}]`),
    "none — cold start (no prior /research or session context)",
  );

  const angleLines = findings
    .filter((x) => x.ok)
    .map((x) => `- **${x.name}**: ${extractLines(x, 6).slice(0, 4).join(" ") || "see findings"}`);
  const techContext =
    angleLines.length > 0
      ? angleLines.join("\n")
      : "- (no code-named investigation angles ran for this descriptor)";

  const testLines = findings
    .filter((x) => x.name === "test-surface" && x.ok)
    .flatMap((x) => extractLines(x));
  const testSurface = sectionBullets(
    testLines,
    "catalogue the tests near the work area in Phase 2",
  );

  const referenceLines = [
    ...new Set(
      findings.flatMap((x) => x.text.match(/\b[\w./-]+\.(?:ts|tsx|js|rs|go|py|md)\b/g) ?? []),
    ),
  ].slice(0, 8);
  const references = sectionBullets(
    referenceLines.map((r) => `${r} — existing pattern or affected surface; verify before editing`),
    "run `codebase_memory_search_code` over the descriptor's identifiers during /work",
  );

  const edgeLines = findings
    .filter((x) => (x.name === "risk-surface" || x.name === "reproduction-surface") && x.ok)
    .flatMap((x) => extractLines(x))
    .slice(0, 6);
  const edgeCases = sectionBullets(edgeLines, "none surfaced by the investigation angles");

  const depthLimit = depth >= EPIC_SUB_ISSUE_DEPTH_LIMIT ? `\n${DEPTH_LIMIT_NOTE}\n` : "";

  const subIssues =
    type === "epic" && depth < EPIC_SUB_ISSUE_DEPTH_LIMIT
      ? `\n## Sub-issues\n\n${epicSubIssues(findings).join("\n") || "- (decomposition not available)"}\n`
      : "";

  const acSection =
    type === "spike"
      ? `## Expected deliverable (NOT code — a decision or proof of concept)\n\n${sectionBullets(
          findings.filter((x) => x.name === "scoping" && x.ok).flatMap((x) => extractLines(x)),
          "a decision or proof of concept — not shipped code",
        )}\n`
      : `## Acceptance criteria\n\n${sectionBullets(
          [...angleLines.slice(0, 0), ...testLines.slice(0, 3), ...edgeLines.slice(0, 2)],
          "derive the testable outcomes from the investigation findings before /work",
        )}\n`;

  const openQ =
    openQuestions.length > 0
      ? openQuestions.map((q) => `- **${q}** — decision owner: PM; status: pending`).join("\n")
      : "- (none)";
  const oos =
    outOfScope.length > 0
      ? outOfScope.map((s) => `- ${s}`).join("\n")
      : "- everything not named in the sections above";

  const body = `## Context & motivation

Descriptor: ${descriptor}
Type: ${type}

## Prior context inventory

${ctx}

## Technical context

${techContext}

${acSection}
## References

${references}

## Test surface

${testSurface}

## Edge cases & pitfalls

${edgeCases}

## Open Questions

${openQ}

## Out of scope

${oos}
${subIssues}${depthLimit}`;

  return { title, body: body.replace(/\n{3,}/g, "\n\n") };
}
