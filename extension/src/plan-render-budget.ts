/**
 * plan-render-budget — the render-budget half of the /plan validation seam.
 *
 * Split out of plan-validate.ts along the AGENTS.md §12 500-line cap. The two
 * halves answer different questions and were already separate concerns in that
 * file: plan-validate.ts decides whether a DRAFTED BODY is acceptable (the
 * fallback-placeholder and pinned-count checks, the operator-authority helpers
 * its checks read), this module decides how much of a body may be RENDERED at
 * all — the per-section item cap, the item clip, the operator ceiling and the
 * two-stage compaction that keeps a spec inside the forge's body limit.
 *
 * plan-validate.ts re-exports everything here for existing consumers, so the
 * split is invisible to callers and no import site moved.
 */

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
 *
 * #1383 lens round 2: this is the budget the POST-FIT appends get, and nothing
 * else. A section cap inside the draft (`DROPPED_SECTION_MAX_CHARS`) is a share
 * of BODY_BUDGET, not of this headroom — the two are spent by different code at
 * different times, and conflating them is how a bounded section can still file
 * over the limit. {@link POST_FIT_APPENDS_MAX_CHARS} is the bound on what can
 * actually be spent here, and the fitter's contract is that the two fit.
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

/**
 * Ceiling on operator items per directive channel (#1087). Operator text is
 * authority, so the render budget never clips it or count-caps it on the angle
 * cap. The parser's block terminators are the other bound, and an unterminated
 * block (the round-9 failure) would otherwise swallow trailing prose unbounded.
 * Past the ceiling the rendered list STATES the omission; oversized bytes still
 * halt at fitDraftToBudget's tooLarge.
 */
export const OPERATOR_ITEM_CEILING = 100;

/**
 * Rendered text for readers only. The halt is decided by operatorOmitted (data),
 * never by searching the body for this phrase.
 */
export const OMISSION_PHRASE = "further operator item(s) omitted";

export interface CappedItems {
  items: string[];
  omitted: number;
}

/**
 * Applies OPERATOR_ITEM_CEILING. The omitted count is returned as data, so the
 * omission is rendered as a status line (omissionNote) rather than as a bullet
 * in the item channel.
 */
export function capOperatorItems(items: string[]): CappedItems {
  return {
    items: items.slice(0, OPERATOR_ITEM_CEILING),
    omitted: Math.max(0, items.length - OPERATOR_ITEM_CEILING),
  };
}

/** The omission status line, outside the bullet list. Empty when nothing was omitted. */
export function omissionNote(capped: CappedItems): string {
  return capped.omitted > 0
    ? `\n_… ${capped.omitted} ${OMISSION_PHRASE} (ceiling ${OPERATOR_ITEM_CEILING}; an unterminated or oversized operator block)_\n`
    : "";
}

/** One operator channel that exceeded the ceiling: the rendered section and how many items were dropped. */
export interface OperatorOmission {
  section: string;
  omitted: number;
}

/**
 * The truncated channels among `channels` (section label → capped result), as
 * data. Carried through draftSpec's result so every filing path decides on the
 * count, not on whether the rendered body happens to contain the status text.
 */
export function operatorOmissions(channels: Record<string, CappedItems>): OperatorOmission[] {
  return Object.entries(channels)
    .filter(([, c]) => c.omitted > 0)
    .map(([section, c]) => ({ section, omitted: c.omitted }));
}

/**
 * The top-level heading an operator DECOMPOSITION block renders under (#1087).
 * It sits OUTSIDE the Sub-issues section, so validateDraft counts the angle
 * list without splitting rendered markdown.
 */
export const OPERATOR_DECOMPOSITION_HEADING = "Operator decomposition";

/** Clip one rendered item with a visible marker. Fallback strings are never items. */
export function clipItem(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * #678: clip at the clip boundary, but if that point lands INSIDE a
 * path-shaped token, back off to just before the token — a truncated path
 * (`see exte…`) is worse than a missing one, because a /work implementer
 * greps for a path that does not exist. No paths in the clip range → the
 * output is byte-identical to `clipItem` (the issue's regression criterion).
 */
export function clipRef(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  // A path-shaped token: word/dot/hyphen segments, at least one `/` OR a
  // dotted name (foo.ts). The trailing `\b` makes the match end at a word
  // boundary, so "plan-validate.ts" inside "extension/src/plan-validate.ts"
  // matches on its own — the backoff loop below expands the token leftward
  // across the slashes to the FULL path, so the whole "extension/src/..." is
  // dropped, not just the "plan-validate.ts" suffix.
  const PATH_TOKEN_RE = /[\w.-]+(?:\/[\w.-]+)*\.\w+\b/g;
  // The left-edge of the current backoff, expanded across `/` segments:
  // "...src/plan-validate.ts" → the start of "extension". Walks left while
  // the char before the current position is a slash, consuming the segment
  // before it; stops when the char before is not a slash (we're at the start
  // of the full path, or the path begins the string).
  const fullTokenStart = (s: number) => {
    let i = s;
    while (i > 0 && text[i - 1] === "/") {
      i--; // consume the slash
      let j = i - 1;
      while (j >= 0 && /[\w.-]/.test(text.charAt(j))) j--;
      i = j + 1; // consume the segment before the slash
    }
    return i;
  };
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    const s = fullTokenStart(m.index ?? 0);
    const e = (m.index ?? 0) + m[0].length;
    if (e <= cut || s >= cut) continue; // whole or absent already — not the problem token
    if (s < cut)
      cut = s; // back off to before the straddling token
    else break; // a token starting at/after cut is already fully absent
  }
  if (cut <= 0) cut = max - 1; // nothing but paths — fall back to the plain clip
  return `${text.slice(0, cut).trimEnd()}…`;
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
 * Try stage 0; over the budget → re-render at stage 1; still over →
 * tooLarge (the caller halts with the breakdown — e.g. an operator context
 * so large no compaction can fit it, which is the operator's call to trim).
 * Pure: at most two cheap string re-renders, byte-deterministic.
 *
 * #1377: `reserve` is the size of content the caller appends to the body AFTER
 * this fitter has chosen it — the caller's provenance lines (plan-provenance.ts),
 * which are deliberately invisible to compaction so nothing can trim them. The
 * budget shrinks by that amount so the FINAL body still fits the forge cap.
 * The default 0 leaves the comparison at BODY_BUDGET exactly, which is what
 * every existing caller passes — its chosen body is byte-identical.
 */
export function fitDraftToBudget<T extends { body: string }>(
  draftAt: (budget: RenderBudget) => T,
  reserve = 0,
): FittedDraft<T> {
  const budget = BODY_BUDGET - reserve;
  const stage0 = RENDER_BUDGETS[0] as RenderBudget;
  const first = draftAt(stage0);
  if (first.body.length <= budget) return { result: first, budget: stage0, compacted: false };
  const stage1 = RENDER_BUDGETS[1] as RenderBudget;
  const second = draftAt(stage1);
  if (second.body.length <= budget) return { result: second, budget: stage1, compacted: true };
  return {
    tooLarge: true,
    size: second.body.length,
    breakdown: bodySectionBreakdown(second.body),
  };
}
