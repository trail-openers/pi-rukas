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
import { type OperatorDirectives, parseOperatorDirectives } from "./plan-directives.ts";
import {
  FORGE_BODY_MAX,
  OPERATOR_ITEM_CEILING,
  type OperatorOmission,
} from "./plan-render-budget.ts";
import { EPIC_SUB_ISSUE_DEPTH_LIMIT, type PlanType } from "./plan-types.ts";
/**
 * #677: normalise text the same way the NEVER CLAIM post-filter and
 * sub-issue reconciliation do — trim, collapse internal whitespace,
 * lowercase. Verbatim-only matching (exact normalised substring); fuzzy
 * matching was measured to false-positive on correctly-negated
 * restatements and the epic's own true invariants, so it is out of scope.
 */
export function normalisePhrase(t: string): string {
  return t.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Normalised-text key for de-duplication (#858): lowercase, collapse
 * whitespace, strip trailing punctuation. Case/whitespace-modulo duplicates
 * ("Offline tests with stubs" / "offline tests with stubs.") collapse; the
 * exact-`.trim()` Set alone would let a case-differing pair both render.
 */
export function normalisedTextKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?)]+$/, "")
    .trim();
}

/**
 * First-occurrence-wins de-duplication on normalised text (#858). The
 * operator's own line wins over a specialist item that restates it.
 */
export function dedupeByNormalised(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const t = s.trim();
    if (!t) continue;
    const k = normalisedTextKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * #677: a forbidden-phrase scan over a body, EXCLUDING the Prior-context
 * inventory section — that section re-renders the operator context verbatim
 * and would always match a phrase the operator themselves declared
 * forbidden (by construction, it contains the "never claim X" ruling).
 * Returns the phrases found in the generated sections.
 */
export function bodyContainsForbiddenPhrase(body: string, phrases: string[]): string[] {
  if (phrases.length === 0) return [];
  const parts = body.split(/^## /m);
  // parts[0] is the preamble; the rest each start with their heading line.
  const nonInventory = parts.slice(1).filter((p) => !/^Prior context inventory/m.test(p));
  const hay = [...(parts[0] ? [parts[0]] : []), ...nonInventory].join("\n");
  const nHay = normalisePhrase(hay);
  const hits = new Set<string>();
  for (const p of phrases) {
    const np = normalisePhrase(p);
    if (np && nHay.includes(np)) hits.add(p);
  }
  return [...hits];
}

/** The Acceptance-criteria fallback draftSpec renders when no AC exists. */
export const AC_FALLBACK =
  "derive the testable outcomes from the investigation findings before /work";

/**
 * #1855: the operator-authority Acceptance-criteria source, in one place.
 *
 * A feature plan used to fill `## Acceptance criteria` only from an
 * `ACCEPTANCE CRITERIA` directive block plus angle items, so an operator who
 * stated the outcome under a prose heading ("Done when:") had those bullets
 * land ONLY in the Prior context inventory — and the plan halted draft-invalid
 * with a section nobody was ever asked to fill.
 *
 * An operator OUTCOME block is now the SAME authority as the directive form:
 * its bullets win over angle criteria (which move to "Suggested additional
 * criteria"), are never clipped or count-capped on the angle cap, and render
 * verbatim — `OPERATOR_ITEM_CEILING` is the only bound. Both forms pool into
 * one list, directive first; a heading that yielded no item contributes nothing
 * (plan-directives.ts never records one), so the section falls back exactly as
 * before rather than rendering empty.
 */
export function operatorAcSource(directives: OperatorDirectives): string[] {
  return dedupeByNormalised([
    ...directives.acceptanceCriteria,
    ...(directives.operatorOutcomes ?? []),
  ]);
}

/** The Sub-issues fallback draftSpec renders when no decomposition exists. */
export const SUB_ISSUES_FALLBACK = "(decomposition not available)";

/**
 * The Test-surface status draftSpec renders when neither the operator nor the
 * investigation produced a test-surface item (#1087). An explicit status, not
 * an instruction: the filed body states the fact instead of reading as an
 * unfilled placeholder. Single-sourced here (the original rule, AC_FALLBACK's
 * sibling: the validator's scan cannot silently drift from what draftSpec renders).
 */
export const TEST_SURFACE_FALLBACK = "no test-surface items were produced";

/** The References fallback draftSpec renders when no reference exists. */
export const REFERENCES_FALLBACK =
  "run `mcp__codebase_memory__search_code` over the descriptor's identifiers during /work";

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

/**
 * True when a section has a bullet line that is EXACTLY the fallback. Whole-line
 * equality (not substring): operator or angle text that merely contains the
 * fallback phrase is data, not the status.
 */
function hasFallbackBullet(section: string | undefined, fallback: string): boolean {
  return !!section && section.split("\n").some((l) => l.trimEnd() === `- ${fallback}`);
}

export interface ValidateOpts {
  /** True when the operator supplied a context param / directives. */
  operatorSupplied?: boolean;
  /** A sub-issue count the operator pinned ("EXACTLY 5 sub-issues"). */
  pinnedSubIssues?: number;
  /**
   * #677: the operator's verbatim forbidden phrases (NEVER CLAIM block).
   * Asserted absent from every GENERATED section of the body; the Prior-
   * context inventory is excluded (it re-renders the operator context
   * verbatim and always matches by construction).
   */
  forbiddenPhrases?: string[];
  /**
   * #1087: operator channels that exceeded OPERATOR_ITEM_CEILING, as data from
   * draftSpec (draftSpec's `operatorOmitted`). REQUIRED — omitting it is a type
   * error. A non-empty list halts validation: the filed spec would be missing
   * operator-supplied items.
   */
  operatorOmitted: OperatorOmission[];
}

export function validateDraft(
  type: PlanType,
  body: string,
  depth: number,
  opts: ValidateOpts,
): DraftValidation {
  const problems: string[] = [];
  const forbidden = (opts.forbiddenPhrases ?? []).filter((p) => p.trim().length > 0);
  if (forbidden.length > 0) {
    const hits = bodyContainsForbiddenPhrase(body, forbidden);
    if (hits.length > 0) {
      problems.push(
        `forbidden phrase(s) from the operator's NEVER CLAIM block appear in a generated section of the drafted body: ${hits
          .map((h) => `"${h}"`)
          .join(", ")} — the prior-context inventory is excluded from this scan by construction`,
      );
    }
  }
  // #1087 review: an operator list past the ceiling is a truncated authority
  // channel — halt rather than file a spec missing operator-supplied items.
  // Decided from the omission DATA, never by searching the rendered body.
  if (opts.operatorOmitted.length > 0) {
    const where = opts.operatorOmitted.map((o) => `${o.omitted} in ${o.section}`).join(", ");
    problems.push(
      `operator-supplied items were truncated past the ceiling of ${OPERATOR_ITEM_CEILING} (${where}) — the operator's block is too large to file faithfully; split the descriptor or reduce the block`,
    );
  }
  if (type === "bug" || type === "feature") {
    const ac = sliceSection(body, "Acceptance criteria");
    if (!ac || hasFallbackBullet(ac, AC_FALLBACK)) {
      // #1855: the problem text names EVERY source the driver tried, so the
      // operator is not sent looking for a directive grammar they never used
      // while their own Done when bullets sit unconsumed in the inventory.
      problems.push(
        "the Acceptance criteria section is the fallback placeholder — none of the three sources produced a testable outcome: (1) an operator ACCEPTANCE CRITERIA directive block, (2) an operator outcome heading with bullets (Done when:, Acceptance: or Acceptance criteria: — a heading with no bullet under it counts as no outcome), (3) acceptance-criterion items from the feature test-surface angle, the only feature angle chartered to report them. Supply the outcome via the context param, or re-run (the angles are re-dispatched): as drafted the issue would not be /work-consumable",
      );
    }
  }
  if (type === "epic" && depth < EPIC_SUB_ISSUE_DEPTH_LIMIT) {
    // Only the angle-derived list counts: the operator DECOMPOSITION block
    // renders under its own top-level heading (#1087), outside this section.
    const sub = sliceSection(body, "Sub-issues");
    if (!sub || hasFallbackBullet(sub, SUB_ISSUES_FALLBACK)) {
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
    if (hasFallbackBullet(deliverable, SPIKE_DELIVERABLE_FALLBACK)) {
      problems.push(
        "the spike's Expected deliverable section is the fallback placeholder despite operator-supplied context — the scoping angle produced nothing and the operator's input never landed",
      );
    }
    const ts = sliceSection(body, "Test surface");
    if (hasFallbackBullet(ts, TEST_SURFACE_FALLBACK)) {
      problems.push(
        "the spike's Test surface section reports no test-surface items despite operator-supplied context — state the intended test surface via a TEST SURFACE block in the context param",
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * #1043 — the final-spec checks every FILING must pass, whichever path files
 * it: the pipeline's pre-filing check (plan-phase5.ts, dry runs included, so a
 * dry run's fileability already reflects them) and the verbatim path that files
 * a reviewed dry run (plan-confirm.ts). A non-empty title; no NEVER CLAIM phrase
 * (read from `context`) in a generated section; a body within the forge limit.
 * Deterministic and cheap — the LLM gates are not re-run here.
 */
export function validateFinalSpec(
  title: string,
  body: string,
  context: string | undefined,
): DraftValidation {
  const problems: string[] = [];
  if (title.trim().length === 0) problems.push("the title is empty");
  const hits = bodyContainsForbiddenPhrase(body, parseOperatorDirectives(context).neverClaim ?? []);
  if (hits.length > 0) {
    problems.push(
      `a NEVER CLAIM phrase appears in a generated section: ${hits.map((h) => `"${h}"`).join(", ")}`,
    );
  }
  if (body.length > FORGE_BODY_MAX) {
    problems.push(
      `the spec is ${body.length} chars, over the forge's ${FORGE_BODY_MAX}-char body limit`,
    );
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// The render-budget half of this seam (the forge body limit, the per-section
// item cap and item clip, the operator ceiling and the two-stage compaction
// fitter) lives in plan-render-budget.ts — AGENTS.md §12 size split. Re-exported
// so no consumer's import site moved.
// ---------------------------------------------------------------------------

export {
  BODY_BUDGET,
  type CappedItems,
  FORGE_BODY_MAX,
  type FittedDraft,
  OMISSION_PHRASE,
  OPERATOR_DECOMPOSITION_HEADING,
  OPERATOR_ITEM_CEILING,
  type OperatorOmission,
  RENDER_BUDGETS,
  type RenderBudget,
  bodySectionBreakdown,
  capOperatorItems,
  clipItem,
  clipRef,
  fitDraftToBudget,
  omissionNote,
  operatorOmissions,
} from "./plan-render-budget.ts";
