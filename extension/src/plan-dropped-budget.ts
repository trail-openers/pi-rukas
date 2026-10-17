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
 * #1383 lens round 2: EVERY interpolable slot in one line is bounded here, and
 * the derived constants below are arithmetic over them — not hand-tuned slack.
 * Round 1 clipped `item.text` and left `item.angle`/`item.kind` raw, so one
 * reporter-supplied 60,000-char angle rendered a 60k section "for the whole
 * section"; and the tests admitted +40/+120/+560 of slack, which is an
 * assumption rather than a pin. A test may now assert
 * `droppedSection(...).length <= DROPPED_SECTION_MAX_CHARS` with no fudge, and
 * a fixture that reaches the cap proves the arithmetic rather than the margin.
 *
 * Split out of plan-validate.ts along the 500-line seam (AGENTS.md §12).
 */

/**
 * Clip on the DECIDING SOURCE inside one drop clause (`against` / `sibling`).
 * Hoisted out of `DROP_CLAUSE` (plan-draft-conflicts.ts) so "what is the most a
 * dropped line can carry" is one question with one answer, asked in one file:
 * the renderer's bound arithmetic subtracts this constant, and a literal edited
 * on either side alone would silently loosen the other.
 */
export const DROPPED_SOURCE_MAX_CHARS = 160;

/**
 * Item text in ONE dropped line. The deciding source (`against` / `sibling`)
 * carries {@link DROPPED_SOURCE_MAX_CHARS}, so a fully loaded `settled` line
 * carries two sources plus this 200-char item. That is why the SECTION cap
 * below is the fileability gate and this clip is the readability bound: a
 * 100-item fixture clipped only per item still renders over the cap.
 */
export const DROPPED_ITEM_MAX_CHARS = 200;

/**
 * Width of the `[angle / kind]` attribution fields. Deliberately NARROWER than
 * {@link DROPPED_ITEM_MAX_CHARS}: these are labels, not findings, and the angle
 * name is reporter-supplied text. `"unknown"` is the longest legal angle name
 * (an angle report that omits `angle` gets `unknown`; the real ones are short
 * slugs), and no `PlanItemKindName` reaches 24 — so the clip can never fire on
 * a real value, which keeps it a bound rather than a truncator.
 */
export const DROPPED_ATTRIBUTION_MAX_CHARS = 24;

/**
 * The longest drop clause's own wording, with its interpolated slots empty:
 * `operator decision "…" settles its clash with the investigation line "…"`
 * measures 69 chars, the `investigation` clause 78. 90 is that measurement
 * rounded up — the one number here describing a clause's prose rather than a
 * clip width, and the reason a `settled` line costs more than an `operator`
 * one. If a clause is ever reworded, this constant is what moves.
 */
export const DROPPED_CLAUSE_PROSE_MAX_CHARS = 90;

/**
 * The fixed scaffolding around one clause: the `- dropped: ` bullet, the ` — `
 * ` [`, ` / `, `] ` and the space before the item text. 28 chars, measured
 * against the empty-field render of the longest clause
 * (`- dropped: operator decision "" settles its clash with the investigation
 * line "" — [ / edge-case] ` is 98 bytes, of which 69 are clause prose, 24 are
 * the `edge-case` kind name and 28 are these bytes).
 */
export const DROPPED_LINE_MARKUP_MAX_CHARS = 28;

/**
 * A conservative ceiling on one dropped line, derived over every clip constant
 * this file owns (2 sources, 3 item-shaped fields, 2 attribution fields, the
 * longest clause's prose, and the markup). The renderer clips every slot to
 * those constants, so the sum is an upper bound the real line never reaches —
 * the section's exact-cap test measures the RENDERED string against
 * {@link DROPPED_SECTION_MAX_CHARS}, which is the assertion that matters; this
 * constant is the arithmetic the reserve is built from.
 */
export const DROPPED_LINE_MAX_CHARS =
  2 * DROPPED_SOURCE_MAX_CHARS +
  3 * DROPPED_ITEM_MAX_CHARS +
  2 * DROPPED_ATTRIBUTION_MAX_CHARS +
  DROPPED_CLAUSE_PROSE_MAX_CHARS +
  DROPPED_LINE_MARKUP_MAX_CHARS;

/**
 * Ceiling on the whole `## Dropped investigation items` section — heading,
 * bullets and omission disclosure included — measured on the rendered string,
 * not on an approximation of it.
 *
 * #1383 lens round 2 — what this cap is NOT: a share of `BODY_BUDGET`'s 4,096-char
 * headroom. The section is spliced into `draftSpec`'s template, so it is part
 * of the DRAFTED body and `fitDraftToBudget` compares it against
 * `BODY_BUDGET - reserve` like every other section; the cap is what turns a
 * dropped-dominated draft from a `tooLarge` halt into a compactable render. The
 * 4,096 headroom is a DIFFERENT budget, spent AFTER the fitter by
 * `filedBodyOf`'s residual gaps + open points + base fallback, the compaction
 * line, the image links and the provenance wrapper — none of which the fitter
 * sees. Reading the cap as "8,000 of the 4,096 I have left" is the arithmetic
 * error that would file over the forge limit; the worst-case arithmetic is
 * therefore explicit rather than implied by the fit:
 *
 * ```text
 *   fitted body            <= BODY_BUDGET - provenanceReservation
 *   post-fit appends       <= POST_FIT_APPENDS_MAX_CHARS   (measured, pinned)
 *   FORGE_BODY_MAX         == BODY_BUDGET + FORGE_BODY_HEADROOM
 *   ⇒ files iff POST_FIT_APPENDS_MAX_CHARS <= FORGE_BODY_HEADROOM
 * ```
 *
 * That inequality is what `test-plan-dropped-section-bound.ts` pins, with the
 * section AT its cap and every other section just under budget. 8,000 ≈ 12% of
 * BODY_BUDGET: large enough to be a useful disclosure, small enough to sit
 * inside the draft without displacing the appends' headroom.
 */
export const DROPPED_SECTION_MAX_CHARS = 8_000;

/**
 * Where the full list of dropped items lives, named in the omission line.
 *
 * #1383 lens round 2: NOT the run transcripts. `/runs` truncates tool args (so
 * the un-clipped item text it claims to hold is not there) and prunes
 * transcripts after 5 days, so "the full list lives in the run transcripts"
 * was a false pointer. The pipeline now WRITES the full list to
 * `<repo>/.pi/plan-dropped/<slug>-<runId>.json` whenever it omitted anything
 * (`writeDroppedArtifact`), and this constant names that path so the body's
 * omission line, the compaction note and the tool result all point at bytes
 * that exist. `plan-tool.ts` renders `droppedListFile` from the result; this
 * constant is the fallback when a run wrote nothing (a read-only checkout).
 */
export const DROPPED_ARTIFACT = "the plan run's dropped-items file";

/**
 * The heading whose presence makes the omission line's pointer moot. When the
 * gap gate surfaced unresolved open points, `filedBodyOf` appends
 * `## Open points (unresolved at the gap-gate cap)` carrying the full text of
 * every conflict — so the omission line points there rather than at a local
 * file a teammate reading the issue cannot open. Declared here rather than
 * imported from open-points-contract.ts to keep this module dependency-free.
 */
export const DROPPED_REOPENED_HEADING = "## Open points (unresolved at the gap-gate cap)";

/**
 * The directory holding the dropped-items artifacts, relative to the repo root.
 * A sibling of `.pi/work-state/` (workflow-state.ts) and `.pi/decisions.jsonl`
 * (decision-log.ts) — the same "durable, per-clone operator artifact" family,
 * and the reason the omission line can promise a location at all.
 */
export const DROPPED_ARTIFACT_DIR = ".pi/plan-dropped";

/**
 * The widest string the omission line can name as the full list's home. The
 * reopened case names the open-points heading; the artifact case names
 * `DROPPED_ARTIFACT_DIR` plus a filename whose slug is capped at 48 chars and
 * whose run digest is 12 (plan-dropped-artifact.ts). Derived over the constants
 * the pointer is built from, so widening any of them widens the reserve too.
 */
export const DROPPED_POINTER_MAX_CHARS = Math.max(
  DROPPED_REOPENED_HEADING.length,
  DROPPED_ARTIFACT_DIR.length + 48 + 12 + 8,
  DROPPED_ARTIFACT.length,
);

/**
 * The omission line's own worst case. Every interpolable slot is bounded here
 * rather than assumed small: the omitted count is at most the section cap
 * divided by the minimum bytes one rendered line costs, and the artifact path
 * is `DROPPED_ARTIFACT` — a constant, so its width enters the arithmetic.
 */
export const DROPPED_OMISSION_LINE_MAX_CHARS =
  DROPPED_SECTION_MAX_CHARS / 10 +
  String(DROPPED_SECTION_MAX_CHARS / 10).length +
  DROPPED_ITEM_MAX_CHARS +
  DROPPED_SOURCE_MAX_CHARS +
  DROPPED_SECTION_MAX_CHARS.toString().length +
  DROPPED_POINTER_MAX_CHARS +
  40;

/**
 * Headroom the renderer keeps back so a budget break keeps the WHOLE section —
 * the line it was about to emit excluded, plus the omission line it replaces it
 * with — inside `DROPPED_SECTION_MAX_CHARS`. Derived from the two worst cases
 * above; no hand-tuned number in it.
 */
export const DROPPED_DISCLOSURE_RESERVE = DROPPED_LINE_MAX_CHARS + DROPPED_OMISSION_LINE_MAX_CHARS;

/**
 * The `## Dropped investigation items` heading. The renderer emits it with a
 * leading newline and a trailing blank line; anything needing the exact bytes
 * of that frame takes {@link droppedSectionFrameChars} rather than repeating
 * the literal (the tests import THIS constant, so a rename is one edit).
 */
export const DROPPED_SECTION_HEADING = "## Dropped investigation items";

/**
 * The most the content appended AFTER `fitDraftToBudget` can cost, and the
 * proof that the 4,096-char headroom is enough for it. Every append site is
 * named and bounded (measured values, pinned by
 * test-plan-dropped-section-bound.ts):
 *
 * - `filedBodyOf`'s residual gaps — each line clipped to
 *   `RESIDUAL_DISPLAY_MAX` (300) by `truncateForDisclosure`, and the gap list
 *   itself is bounded by the gate's iteration cap;
 * - `openPointsSection` — same 300-char clip, plus the contract intro line;
 * - `baseFallbackSection` — one sentence plus the reason string;
 * - the compaction note (`plan-driver.ts`) and the NEVER CLAIM disclosure, each
 *   a fixed lead plus items already clipped upstream;
 * - `planImageLinksSection` and the provenance wrapper (`provenanceReservation`,
 *   which the fitter already subtracts for itself — see `reserve`).
 *
 * 3,072 is the sum of those measured maxima with room to spare; the assertion
 * that matters is `POST_FIT_APPENDS_MAX_CHARS <= FORGE_BODY_MAX - BODY_BUDGET`,
 * which the test states outright so a future append that widens any of these
 * has to move a number the reader sees.
 */
export const POST_FIT_APPENDS_MAX_CHARS = 3_072;

/**
 * The heading frame the renderer emits around the bullets: `"\n" + heading +
 * "\n\n"` leading and `"\n"` trailing. The renderer subtracts this from the cap
 * before laying bullets out, and the exact-cap test adds it back — one
 * constant, so the two cannot disagree about what the section costs.
 */
export function droppedSectionFrameChars(): number {
  return `\n${DROPPED_SECTION_HEADING}\n\n`.length + 1;
}
