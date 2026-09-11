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
 *
 * Phase 2's children report items via the `report_plan_item` tool
 * (plan-reporter.ts); this module reads structured items from
 * `result.toolUses` — no line-splitting prose (D1-D8 fix).
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";
import { epicSubIssues } from "./plan-angles.ts";
import { PLAN_ITEM_KINDS } from "./plan-reporter.ts";
import { EPIC_SUB_ISSUE_DEPTH_LIMIT, type PlanType, planTitle } from "./plan-types.ts";
import {
  AC_FALLBACK,
  REFERENCES_FALLBACK,
  type RenderBudget,
  SPIKE_DELIVERABLE_FALLBACK,
  SUB_ISSUES_FALLBACK,
  TEST_SURFACE_FALLBACK,
  clipItem,
} from "./plan-validate.ts";
import {
  type ResolvedDecision,
  applyWritebackToBody,
  markWrittenDecisions,
  renderOpenQuestions,
} from "./plan-writeback.ts";
import type { MemoryHit } from "./vipune.ts";
import { vipuneSearch } from "./vipune.ts";

const execp = promisify(exec);

/**
 * Resolve the forge adapter for the plan-draft inventory step
 * (#612 S4 task-b). `PI_ENSEMBLE_FORGE=none` refuses; unknown detection
 * falls back to raw `gh` (pre-migration behaviour).
 */
async function planDraftForge(repoRoot: string): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  try {
    const det = await detectForge(repoRoot, {});
    if (det.forge === "unknown") return undefined;
    return createForge(det, { cwd: repoRoot });
  } catch {
    return undefined;
  }
}

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
  forgeOverride?: Forge,
): Promise<MechanicalInventory> {
  const keywords = descriptor
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^(the|and|with|from|into|that|this|which|when)\b/i.test(w))
    .slice(0, 4);
  const terms = keywords.length > 0 ? keywords.join(" ") : descriptor.slice(0, 60);
  // #612 S4 task-b — forge adapter (an unresolvable forge yields an empty
  // related list, no error). The two legs share no data — concurrent.
  const [res, forgeSide] = await Promise.all([
    vipuneSearch(terms, { cwd: repoRoot, limit: 5 }),
    (async () => {
      const related: MechanicalInventory["related"] = [];
      const errors: string[] = [];
      const forge = forgeOverride ?? (await planDraftForge(repoRoot));
      if (forge) {
        try {
          const rows = await forge.issueSearch(terms.replace(/'/g, ""));
          for (const r of rows) related.push({ number: r.number, title: r.title, state: r.state });
        } catch (err) {
          errors.push(`forge issueSearch: ${(err as Error).message.split("\n")[0]}`);
        }
      }
      return { related, errors };
    })(),
  ]);
  return { memory: res.kind === "hits" ? res.hits : [], ...forgeSide };
}

// ---------------------------------------------------------------------------
// Phase 2 — type-specialised investigation (parallel explore)
//
// The per-ticket-type angle table + prompt construction live in
// plan-angles.ts (kept out of this file by the 500-line hard limit).
// ---------------------------------------------------------------------------

export { anglePromptsFor, type Angle } from "./plan-angles.ts";

// ---------------------------------------------------------------------------
// Phase 3 — draft synthesis (driver assembles the body)
// ---------------------------------------------------------------------------

export interface AngleFindings {
  name: string;
  ok: boolean;
  text: string;
  /** Structured items from this angle's tool calls (empty = zero valid calls). */
  toolUses: PlanItemKind[];
  /** Why the angle is not ok (timeout/provider/prose-only) — rendered, never hidden. */
  failure?: string;
}

export interface PlanItemKind {
  kind: string;
  text: string;
  angle: string;
}

export type PlanItemKindName = (typeof PLAN_ITEM_KINDS)[number];

/**
 * Extract report_plan_item calls from an angle's tool_uses (the structured
 * record — the prose reply is only a human-readable summary). Follows the
 * lens-review / policy-judge precedent: read result.toolUses, no text
 * parsing. Schema-invalid items (unknown kind, empty text) are dropped.
 */
export function extractPlanItems(toolUses: unknown[], angleName: string): PlanItemKind[] {
  const out: PlanItemKind[] = [];
  for (const tu of toolUses) {
    if (!tu || typeof tu !== "object") continue;
    const t = tu as { name?: string; arguments?: unknown };
    if (t.name !== "report_plan_item" || !t.arguments || typeof t.arguments !== "object") continue;
    const a = t.arguments as Record<string, unknown>;
    const kind = typeof a.kind === "string" ? a.kind : "";
    if (!(PLAN_ITEM_KINDS as readonly string[]).includes(kind)) continue;
    const text = typeof a.text === "string" ? a.text.trim() : "";
    if (!text) continue;
    const angle = typeof a.angle === "string" && a.angle.trim() ? a.angle.trim() : angleName;
    out.push({ kind: kind as PlanItemKindName, text, angle });
  }
  return out;
}

// parseOperatorDirectives + OperatorDirectives live in plan-directives.ts
// (the operator's trusted typed channel); re-exported for existing consumers.
import type { OperatorDirectives } from "./plan-directives.ts";
export { type OperatorDirectives, parseOperatorDirectives } from "./plan-directives.ts";

function sectionBullets(items: string[], fallback: string): string {
  const clean = [...new Set(items.map((s) => s.trim()))].filter((s) => s.length > 0);
  return clean.length > 0 ? clean.map((s) => `- ${s}`).join("\n") : `- ${fallback}`;
}

/**
 * #639: the plain cross-angle aggregation (flatMap + filter, NO dedupe) the
 * non-sub-issue kinds legitimately pool through. Exported for the
 * reconciliation canary (test-plan-subissue-reconciliation.ts): the shared
 * normalisation helper must NOT leak into this helper — the Test surface /
 * References sections keep aggregating identical items across angles.
 */
export function itemsByKind(findings: AngleFindings[], kind: PlanItemKindName): PlanItemKind[] {
  return findings.flatMap((f) => f.toolUses).filter((i) => i.kind === kind);
}

// The child-prompt prior-context render (operator channel exempt from the
// shared cap) lives in plan-prior-context.ts — re-exported for existing
// consumers (plan-angles, plan-gate-prompt, plan-investigate,
// research-driver). draftSpec (the FILED body) renders priorContext
// uncapped (D2) — the caps exist only at the child-prompt render site.
export {
  OPERATOR_PRIOR_CONTEXT_CHILD_PROMPT_CAP,
  PRIOR_CONTEXT_CHILD_PROMPT_CAP,
  forbiddenPhrasesBlock,
  renderPriorContext,
} from "./plan-prior-context.ts";

// #639: epicSubIssues is in plan-angles.ts (the natural home for the epic
// angle charter); imported below where it's used in draftSpec.

const DEPTH_LIMIT_NOTE =
  "- spec depth limit reached — run start_plan_driver with this descriptor for the full spec";

/** Max items rendered per typed section — generous enough for a real spec (D2). */
const SECTION_MAX_ITEMS = 20;

/**
 * D6: the source tag for vipune-sourced prior-context entries.
 *
 * A blocked planning session naturally saves its spec to vipune; the next
 * run retrieves that stale copy, and the gap gate can raise a CRITICAL over a
 * "contradiction" between the operator's CURRENT context and their own
 * two-runs-old snapshot (FIELD-CONFIRMED in transcript mtsnbz8b — the same
 * vipune entry "ebfa12c1" quoted its own prior ACs into the next round's
 * gap-gate prompt). The tag makes the entry's provenance visible to the
 * reviewer, and the precedence instruction (VIPUNE_PRECEDENCE_NOTE) tells
 * both the Phase-2 angle children and the gap gate that a vipune entry is a
 * prior snapshot, not live authority.
 */
export const VIPUNE_PRIOR_SOURCE = "vipune (prior snapshot — may be stale)";

/**
 * D6: the explicit precedence instruction rendered into BOTH the angle
 * prompts (plan-angles.ts: buildAnglePrompt) and the gap-gate prompt
 * (plan-driver.ts: gapGatePrompt) whenever prior context contains vipune
 * entries. On conflict between a vipune-sourced entry and a context-param
 * entry or live code, the LIVE context wins: vipune entries are from a
 * previous run and may be stale.
 */
export const VIPUNE_PRECEDENCE_NOTE =
  "PRECEDENCE: entries tagged with a vipune source are snapshots saved during a previous planning run and MAY BE STALE. On conflict between a vipune-sourced entry and a context-param entry or live code, the LIVE context (context param / current code) wins — do not raise a gap for a vipune entry that conflicts with live context, and do not let a stale vipune entry contradict the operator's current instructions.";

export function priorContextHasVipune(priorContext: { source: string; fact: string }[]): boolean {
  return priorContext.some((p) => p.source.startsWith("vipune"));
}

/**
 * D5: the Technical-context line for one angle — a per-kind COUNT of its
 * structured items plus the angle's prose summary, NEVER the item text.
 *
 * The old shape rendered every structured item here AND again in its typed
 * section (the same item twice, with the copies drifting — one copy citing a
 * file at :95 and another at :89). The prose summary is already extracted
 * below; promote it from fallback to the line's second half, so the typed
 * sections remain the single record of the item text.
 */
export function techContextLine(x: {
  name: string;
  text: string;
  toolUses: { kind: string }[];
}): string {
  const byKind = new Map<string, number>();
  for (const i of x.toolUses) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
  const counts = [...byKind.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
  const prose = x.text
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 4)
    .join("; ");
  const summary = prose || "(no prose summary)";
  return `- **${x.name}**: ${counts ? `${counts}; ` : ""}${summary}`;
}

// #633 SIMPLICITY-lens note: the references fallback (REF_RE prose file-path
// scan) SURVIVES where the sub-issue prose fallback does not: a file-path regex
// is narrow and high-precision. Structured reference items take precedence; the
// scan fires only when an angle made zero reference calls.
const REF_RE = /\b[\w./-]+\.(?:ts|tsx|js|rs|go|py|md)\b/g;

/**
 * #638 deliverable 3 (task-b): the REF_RE prose fallback renders as a TO-BE
 * CREATED suggestion, never as confirmed existing code. The old suffix
 * ("existing pattern or affected surface; verify before editing") labelled a
 * path the angle merely named in prose as real code — on a repo where the
 * code does not exist yet, an honest angle returns zero structured references,
 * so the fallback is the DEFAULT path there and the fabricated label shipped.
 */
export const PROSE_REF_SUFFIX =
  "suggested path from the angle's prose — NOT confirmed to exist; verify with codebase_memory_search_code before treating it as an existing file, or create it";

export function draftSpec(
  type: PlanType,
  descriptor: string,
  findings: AngleFindings[],
  priorContext: { source: string; fact: string }[],
  openQuestions: string[],
  outOfScope: string[],
  depth: number,
  directives: OperatorDirectives,
  // #639 DECISION B: carried gap-gate decisions travel structured here;
  // `openQuestions` stays genuinely-open strings (see plan-writeback.ts).
  resolvedDecisions: ResolvedDecision[],
  // The writeback heading → bullets map. draftSpec is the SINGLE splice
  // site (PR #640): it rebuilds the body and applies the writeback once,
  // reporting outcomes so writtenBack is PRODUCED by the write.
  writebackMap?: Map<string, string[]>,
  // Render budget (plan-validate.ts): per-section item cap + item clip.
  // ANGLE items clip; operator directive lines and fallbacks never do
  // (operator authority, D2) — they count toward the budget and the
  // tooLarge halt covers the extreme.
  budget?: RenderBudget,
): { title: string; body: string; resolvedDecisions: ResolvedDecision[] } {
  const title = planTitle(descriptor, type);
  const cap = budget?.maxItemsPerSection ?? SECTION_MAX_ITEMS;
  const clip = (s: string) => clipItem(s, budget?.itemClipChars ?? 400);

  // D2: no clipping of operator context; the inventory is not capped at 8.
  const ctx = sectionBullets(
    priorContext.map((p) => `${p.fact} [${p.source}]`),
    "none — cold start (no prior /research or session context)",
  );

  // Technical context: per-kind COUNT + prose summary (D5), never item
  // text. A FAILED angle renders its hole explicitly (vipune fixture run).
  const angleLines = findings.map((x) =>
    x.ok
      ? clip(techContextLine(x))
      : `- **${x.name}**: (${x.failure ?? "failed"} — NOT investigated; treat this surface as unverified)`,
  );
  const techContext =
    angleLines.length > 0
      ? angleLines.join("\n")
      : "- (no code-named investigation angles ran for this descriptor)";

  // Acceptance criteria — operator directives first, then structured items
  // from ALL angles (D1: the Test surface section no longer double-uses lines).
  const acItems = [
    ...directives.acceptanceCriteria,
    ...itemsByKind(findings, "acceptance-criterion").map((i) => clip(i.text)),
  ].slice(0, cap);

  // An operator TEST SURFACE directive REPLACES the angle items (unlike
  // ACs, which prepend) — "exactly: none" must not be diluted (C2). The
  // count cap applies to BOTH branches (round 9: an unterminated block
  // swallowed trailing prose unbounded); operator text stays unclipped (D2).
  const opTestSurface = directives.testSurface ?? [];
  const testSurface = sectionBullets(
    (opTestSurface.length > 0
      ? opTestSurface
      : itemsByKind(findings, "test-surface-item").map((i) => clip(i.text))
    ).slice(0, cap),
    TEST_SURFACE_FALLBACK,
  );

  // References: structured reference items first; fallback to a prose
  // file-path scan only when none were reported (silence-detection precedent).
  const refItems = itemsByKind(findings, "reference")
    .map((i) => clip(i.text))
    .slice(0, cap);
  const proseRefs = [...new Set(findings.flatMap((x) => x.text.match(REF_RE) ?? []))].slice(0, 8);
  const referenceLines =
    refItems.length > 0 ? refItems : proseRefs.map((r) => `${r} — ${PROSE_REF_SUFFIX}`);
  const references = sectionBullets(referenceLines, REFERENCES_FALLBACK);

  // D3 fix: edge cases come from the "edge-case" kind across ALL angles (the
  // old filter matched a nonexistent "risk-surface" angle name). Operator
  // pitfalls take precedence.
  const edgeItems = [
    ...directives.pitfalls,
    ...itemsByKind(findings, "edge-case").map((i) => clip(i.text)),
  ].slice(0, cap);
  const edgeCases = sectionBullets(edgeItems, "none surfaced by the investigation angles");

  const depthLimit = depth >= EPIC_SUB_ISSUE_DEPTH_LIMIT ? `\n${DEPTH_LIMIT_NOTE}\n` : "";

  // Sub-issue COUNT is never budget-capped (a pinned "EXACTLY N" must
  // survive compaction); only the per-item TEXT clips — epicSubIssues
  // clips before decorating so the checkbox prefix and the
  // "(sub-issue N, from angle)" attribution survive every budget stage.
  const subIssues =
    type === "epic" && depth < EPIC_SUB_ISSUE_DEPTH_LIMIT
      ? `\n## Sub-issues\n\n${
          epicSubIssues(findings, clip).join("\n") || `- ${SUB_ISSUES_FALLBACK}`
        }\n`
      : "";

  const oosAll = [
    ...directives.outOfScope,
    ...itemsByKind(findings, "out-of-scope").map((i) => clip(i.text)),
    ...outOfScope,
  ];

  // Spike's deliverable section reuses the scoping angle's items; the
  // non-spike acceptance-criteria section is built from acItems above.
  // Spike deliverable: operator ACs lead here too (C2).
  const acSection =
    type === "spike"
      ? `## Expected deliverable (NOT code — a decision or proof of concept)\n\n${sectionBullets(
          [
            ...directives.acceptanceCriteria,
            ...findings
              .filter((x) => x.name === "scoping" && x.ok)
              .flatMap((x) => x.toolUses)
              .map((i) => clip(i.text)),
          ].slice(0, cap),
          SPIKE_DELIVERABLE_FALLBACK,
        )}\n`
      : `## Acceptance criteria\n\n${sectionBullets(acItems, AC_FALLBACK)}\n`;
  const oos =
    oosAll.length > 0
      ? oosAll.map((s) => `- ${s}`).join("\n")
      : "- everything not named in the sections above";

  // Placeholder Open Questions section ("- (none)"): the real content is
  // rendered LAST — after the splice and markWrittenDecisions — because
  // writtenBack is produced by the write, not predicted before it.
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

- (none)

## Out of scope

${oos}
${subIssues}${depthLimit}`;

  // PR #640: single splice site (the dead onCorrective splice is gone).
  // Splice → collapse → render Open Questions from marked decisions →
  // replace placeholder. A heading that did not survive rendering
  // renders status: open (the loss is visible, never a false resolved).
  const { body: spliced, outcomes } = applyWritebackToBody(body, writebackMap ?? new Map());
  const collapsed = spliced.replace(/\n{3,}/g, "\n\n");
  const markedDecisions = markWrittenDecisions(resolvedDecisions, outcomes);
  const openQ = renderOpenQuestions(openQuestions, markedDecisions);
  const finalBody = collapsed.replace(
    "## Open Questions\n\n- (none)\n",
    `## Open Questions\n\n${openQ}\n`,
  );

  return { title, body: finalBody, resolvedDecisions: markedDecisions };
}
