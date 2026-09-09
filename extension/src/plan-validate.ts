/**
 * plan-validate — deterministic validation of the drafted spec body, run
 * AFTER draftSpec and BEFORE the gap gate.
 *
 * The research base (outputs/spec-driven-plan-driver-gap.md, G4) notes the
 * pipeline's only deterministic checks were parser-level: a draft whose
 * load-bearing sections all fell back to placeholder strings could reach
 * the LLM gap gate (paying a reviewer dispatch to notice junk) or — for
 * the types the gate does not cover — the forge. These checks are free,
 * mechanical, and identical on every run.
 *
 * Deliberately NARROW (the all-angles-failed guard already catches total
 * junk; this catches the partial case where SOME angle produced items but
 * the load-bearing section still fell back):
 *
 *   - bug/feature: the Acceptance criteria section must not be the
 *     fallback placeholder — an issue with zero real ACs is not
 *     /work-consumable (work-driver-plan-helpers.ts counts AC lines).
 *   - epic (below the sub-issue depth limit): the Sub-issues section must
 *     contain an actual decomposition, and a sane number of entries.
 *   - chore/spike: no additional check. A spike has one angle, so a spike
 *     with no deliverable items is already the all-angles-failed halt; a
 *     chore's smallest-viable-change shape does not require structured ACs.
 *
 * Type/content plausibility ("is this feature really an epic?") is NOT
 * checked here — that is a judgment call, and deterministic heuristics for
 * it would trade false halts for nothing the gap gate does not already
 * cover.
 *
 * The fallback strings are declared HERE and imported by plan-draft.ts's
 * draftSpec — single source, so a reworded placeholder cannot silently
 * stop matching the validator.
 */
import { EPIC_SUB_ISSUE_DEPTH_LIMIT, type PlanType } from "./plan-types.ts";

/** The Acceptance-criteria fallback draftSpec renders when no AC exists. */
export const AC_FALLBACK =
  "derive the testable outcomes from the investigation findings before /work";

/** The Sub-issues fallback draftSpec renders when no decomposition exists. */
export const SUB_ISSUES_FALLBACK = "(decomposition not available)";

/** The Test-surface fallback (single-sourced here so the validator's scan
 * cannot silently drift from what draftSpec renders — same rule as
 * AC_FALLBACK). */
export const TEST_SURFACE_FALLBACK = "catalogue the tests near the work area in Phase 2";

/** The References fallback draftSpec renders when no reference exists. */
export const REFERENCES_FALLBACK =
  "run `codebase_memory_search_code` over the descriptor's identifiers during /work";

/** The spike Expected-deliverable fallback. */
export const SPIKE_DELIVERABLE_FALLBACK = "a decision or proof of concept — not shipped code";

/**
 * A count the operator pinned ("EXACTLY 5 sub-issues") in the descriptor
 * or context. Deterministic; undefined when no pin (or an insane one).
 */
export function parsePinnedSubIssueCount(text: string): number | undefined {
  const m = text.match(/exactly\s+(\d+)\s+sub[- ]?issues?/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= EPIC_SUB_ISSUE_MAX ? n : undefined;
}

/**
 * Sanity ceiling for an epic's sub-issue count — SECTION_MAX_ITEMS-sized;
 * a decomposition past it is a runaway angle, not a plan.
 */
export const EPIC_SUB_ISSUE_MAX = 20;

export interface DraftValidation {
  ok: boolean;
  problems: string[];
}

/** Extract one `## <heading>` section's content (up to the next `## `). */
function sliceSection(body: string, heading: string): string | undefined {
  const re = new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m");
  const m = body.match(re);
  return m?.[1];
}

export interface ValidateOpts {
  /** True when the operator supplied a context param / directives. */
  operatorSupplied?: boolean;
  /** A sub-issue count the operator pinned ("EXACTLY 5 sub-issues"). */
  pinnedSubIssues?: number;
}

export function validateDraft(
  type: PlanType,
  body: string,
  depth: number,
  opts: ValidateOpts = {},
): DraftValidation {
  const problems: string[] = [];
  if (type === "bug" || type === "feature") {
    const ac = sliceSection(body, "Acceptance criteria");
    if (!ac || ac.includes(AC_FALLBACK)) {
      problems.push(
        "the Acceptance criteria section is the fallback placeholder — no angle or operator directive produced a testable outcome, so the issue would not be /work-consumable",
      );
    }
  }
  if (type === "epic" && depth < EPIC_SUB_ISSUE_DEPTH_LIMIT) {
    const sub = sliceSection(body, "Sub-issues");
    if (!sub || sub.includes(SUB_ISSUES_FALLBACK)) {
      problems.push(
        "the epic has no sub-issue decomposition — the decomposition-surface angle produced no sub-issue items",
      );
    } else {
      const n = (sub.match(/^- /gm) ?? []).length;
      if (n > EPIC_SUB_ISSUE_MAX) {
        problems.push(
          `the epic decomposed into ${n} sub-issues (ceiling ${EPIC_SUB_ISSUE_MAX}) — a decomposition this wide is a runaway angle, not a plan; split the epic descriptor instead`,
        );
      } else if (opts.pinnedSubIssues !== undefined && n !== opts.pinnedSubIssues) {
        // C5 (vipune fixture run): five test rounds produced 9→10→8→3
        // sub-issues against a pinned "EXACTLY 5" and nothing checked.
        problems.push(
          `the operator pinned EXACTLY ${opts.pinnedSubIssues} sub-issues and the decomposition produced ${n} — re-run (the pin is threaded into the decomposition angle), or drop the pin from the descriptor/context`,
        );
      }
    }
  }
  if (type === "spike" && opts.operatorSupplied) {
    // C2 (vipune fixture run): a spike has no gap gate by design, so with
    // operator input in play the deterministic bar is the only bar — a
    // deliverable or test-surface section still showing scaffold strings
    // means the operator's instructions never landed.
    const deliverable = sliceSection(body, "Expected deliverable");
    if (deliverable?.includes(SPIKE_DELIVERABLE_FALLBACK)) {
      problems.push(
        "the spike's Expected deliverable section is the fallback placeholder despite operator-supplied context — the scoping angle produced nothing and the operator's input never landed",
      );
    }
    const ts = sliceSection(body, "Test surface");
    if (ts?.includes(TEST_SURFACE_FALLBACK)) {
      problems.push(
        "the spike's Test surface section is the fallback placeholder despite operator-supplied context — state the intended test surface via a TEST SURFACE block in the context param",
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Body budget — specs must fit the forge (vipune session, 2026-09-09: four
// consecutive filings hit GitHub's 65,536-char wall, including a
// quarter-scope ticket that passed its gap gate — body size scales with
// INVESTIGATION volume, not feature complexity, and nothing budgeted it).
// ---------------------------------------------------------------------------

/** GitHub's issue-body cap. GitLab's is larger; one conservative limit serves both. */
export const FORGE_BODY_MAX = 65536;

/**
 * The render budget: headroom under the cap for the residual-disclosure
 * append and corrective-round writeback bullets that land AFTER drafting.
 */
export const BODY_BUDGET = FORGE_BODY_MAX - 4096;

export interface RenderBudget {
  maxItemsPerSection: number;
  itemClipChars: number;
}

/**
 * Stage 0 is the DEFAULT render (a >400-char "item" is an essay — the
 * reporter prompt demands one self-contained item); stage 1 is compaction.
 * Hardcoded, deterministic, no env knobs.
 */
export const RENDER_BUDGETS: readonly RenderBudget[] = [
  { maxItemsPerSection: 20, itemClipChars: 400 },
  { maxItemsPerSection: 10, itemClipChars: 220 },
];

/** Clip one rendered item with a visible marker. Fallback strings are never items. */
export function clipItem(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Per-`## heading` char counts — the halt detail's "what to trim" map. */
export function bodySectionBreakdown(body: string): string {
  const parts = body.split(/^## /m);
  const rows: string[] = [];
  if ((parts[0] ?? "").length > 0) rows.push(`(preamble): ${parts[0]?.length ?? 0} chars`);
  for (const p of parts.slice(1)) {
    const heading = (p.split("\n")[0] ?? "").trim();
    rows.push(`${heading}: ${p.length + 3} chars`);
  }
  return rows.join("; ");
}

export type FittedDraft<T extends { body: string }> =
  | { result: T; budget: RenderBudget; compacted: boolean }
  | { tooLarge: true; size: number; breakdown: string };

/**
 * Try stage 0; over BODY_BUDGET → re-render at stage 1; still over →
 * tooLarge (the caller halts with the breakdown — e.g. an operator context
 * so large no compaction can fit it, which is the operator's call to trim).
 * Pure: at most two cheap string re-renders, byte-deterministic.
 */
export function fitDraftToBudget<T extends { body: string }>(
  draftAt: (budget: RenderBudget) => T,
): FittedDraft<T> {
  const stage0 = RENDER_BUDGETS[0] as RenderBudget;
  const first = draftAt(stage0);
  if (first.body.length <= BODY_BUDGET) return { result: first, budget: stage0, compacted: false };
  const stage1 = RENDER_BUDGETS[1] as RenderBudget;
  const second = draftAt(stage1);
  if (second.body.length <= BODY_BUDGET) return { result: second, budget: stage1, compacted: true };
  return {
    tooLarge: true,
    size: second.body.length,
    breakdown: bodySectionBreakdown(second.body),
  };
}
