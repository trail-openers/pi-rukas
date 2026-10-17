/**
 * plan-dropped-budget — the character bounds on the `## Dropped investigation
 * items` section (#1383).
 *
 * One dry run filed nothing because this section alone reached 56,738 chars
 * while every other section stayed small, pushing the body past the forge's
 * 65,536-char cap. It was the ONE section `draftSpec` never passed through
 * `clip()` or a count cap, and the reason `fitDraftToBudget`'s stage-1
 * re-render shrank nothing: both RENDER_BUDGETS stages vary
 * `maxItemsPerSection`/`itemClipChars`, which this section does not read.
 *
 * These are deliberately their OWN constants and not fields of `RenderBudget`.
 * Both budget stages (20 items/400 chars, 10 items/220 chars) EXCEED these
 * bounds, so a `RenderBudget` field would make the section non-monotone in the
 * fit — stage 1 smaller than stage 0 — and a cap that only took effect at stage
 * 1 would reproduce the bug: the first render keeps reporting 56k chars, so the
 * fitter halts `tooLarge` before compaction ever runs. A constant that applies
 * at both stages is what makes the bound land BEFORE the budget check.
 *
 * Split out of plan-validate.ts along the 500-line seam (AGENTS.md §12).
 */

/**
 * Item text in ONE dropped line. The deciding source (`against` / `sibling`)
 * keeps its own 160-char clip in plan-draft-conflicts.ts, so a fully loaded
 * `settled` line carries two 160-char sources plus this 200-char item — ~700
 * chars by construction. That is why the SECTION cap below is the fileability
 * gate and this clip is the readability bound: a 100-item fixture clipped only
 * per item still renders ~20k chars, 2.5× over any section cap.
 */
export const DROPPED_ITEM_MAX_CHARS = 200;

/**
 * Ceiling on the whole `## Dropped investigation items` section, the omission
 * disclosure line included. Comfortably inside `BODY_BUDGET`'s 4,096-char
 * headroom, so a dropped-dominated draft cannot starve the post-fit appends
 * (`filedBodyOf`'s residual gaps + open points, the compaction line, the image
 * links) and re-trigger the halt after the gate has already run.
 */
export const DROPPED_SECTION_MAX_CHARS = 8_000;

/**
 * Headroom reserved for the omission line so a budget break keeps the whole
 * section inside `DROPPED_SECTION_MAX_CHARS`. Generous against the longest line
 * the renderer can produce (two 160-char sources + one 200-char item + markup).
 */
export const DROPPED_DISCLOSURE_RESERVE = 600;

/**
 * Where the full list of dropped items lives, named in the omission line. Same
 * location `plan-tool.ts`'s COMPACTED note points the operator at, so the body
 * and the tool result name one place for the full findings.
 */
export const DROPPED_ARTIFACT = "the run transcripts (/runs)";

/** The `## Dropped investigation items` heading, shared by the renderer and its tests. */
export const DROPPED_SECTION_HEADING = "## Dropped investigation items";
