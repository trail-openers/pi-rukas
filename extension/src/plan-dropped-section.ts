/**
 * plan-dropped-section — the bounded renderer for the `## Dropped investigation
 * items` disclosure (#1383).
 *
 * Extracted from plan-draft-conflicts.ts along the 500-line seam (AGENTS.md
 * §12); the drop DECISIONS (filterInvestigationConflicts, which items go) stay
 * there — this file owns how much of an already-decided disclosure RENDERS, and
 * after #1383 that includes the clause wording, so `droppedDisclosure` moved
 * here with it. plan-draft-conflicts.ts keeps the producer and re-exports the
 * renderer's helpers to its existing consumers.
 */

import {
  DROP_CLAUSE,
  type DroppedInvestigationItem,
  type PLAN_DROP_REASONS,
} from "./plan-draft-conflicts.ts";
import type { PlanItemKindName } from "./plan-draft.ts";
import {
  DROPPED_ARTIFACT,
  DROPPED_ARTIFACT_DIR,
  DROPPED_ATTRIBUTION_MAX_CHARS,
  DROPPED_DISCLOSURE_RESERVE,
  DROPPED_ITEM_MAX_CHARS,
  DROPPED_REOPENED_HEADING,
  DROPPED_SECTION_HEADING,
  DROPPED_SECTION_MAX_CHARS,
  DROPPED_SOURCE_MAX_CHARS,
  droppedSectionFrameChars,
} from "./plan-dropped-budget.ts";
import { flattenAndClip } from "./text-flatten.ts";

/**
 * The literal scaffolding of one `droppedDisclosure` line — the `- dropped: `
 * bullet, the ` — [` / ` / ` / `] ` attribution punctuation and the clause's
 * two quotation marks — measured against the empty-field render of the longest
 * clause. Exported so the renderer's own arithmetic is checkable against what
 * `droppedDisclosure` actually emits (test-plan-dropped-section-bound.ts builds
 * the longest legal line and asserts the non-field bytes are no more than
 * DROPPED_LINE_MAX_CHARS predicts).
 */
export const DROPPED_DISCLOSURE_FRAME = "- dropped:  — [ / ] ".length;

/**
 * Never emit a lone high surrogate at the cut. `clipItem` slices by UTF-16 code
 * unit, so a clip landing between the halves of an astral character (an emoji,
 * many CJK-extension glyphs) leaves a dangling half — which renders as `?` and
 * which `String.prototype.isWellFormed()` reports as malformed. Dropping the
 * orphan unit is cheaper than a surrogate-pair-aware scan and loses one
 * character. Environment guard: `isWellFormed` is ES2024, and a renderer that
 * throws on an old host would take the whole pipeline down for cosmetics.
 */
function wellFormed(s: string): string {
  // Structured call, not `s.isWellFormed()`: `lib` is ES2022 here and the
  // method is ES2024, so the type has no declaration for it. The runtime check
  // above is what makes the cast safe — Bun and modern Node both have it.
  const probe = s as string & { isWellFormed?: () => boolean };
  return probe.isWellFormed?.() === false ? s.slice(0, -1) : s;
}

/**
 * The disclosure bullet for one dropped item (rendered in the filed body).
 *
 * #1383 lens round 2: EVERY interpolable slot is clipped. Round 1 clipped only
 * `item.text`, leaving `item.angle` and `item.kind` raw — reporter-supplied
 * strings — so ONE item carrying a 60,000-char angle rendered a 60k section
 * under a section that claimed an 8,000-char cap. `maxChars` shrinks the item
 * text below {@link DROPPED_ITEM_MAX_CHARS} so the caller can fill the room
 * exactly with a partial line rather than omit the item entirely.
 */
export function droppedDisclosure(d: DroppedInvestigationItem, maxChars?: number): string {
  // Every field is FLATTENED before it is clipped, and clipping is by code
  // point (`flattenAndClip`), which closes two round-2 defeats at once:
  //
  // - an untrusted investigation item (or an operator line, or an angle name)
  //   containing "\n## Open points (unresolved at the gap-gate cap)" or
  //   "\n## Sub-issues" used to open a REAL body heading inside this section —
  //   `readOpenPoints` then returned a smuggled CRITICAL, and an epic with no
  //   decomposition passed its gate because the smuggled section carried
  //   bullets. One inert line is the only shape a disclosure may take.
  // - a clip between the halves of an astral character left a lone surrogate.
  const clause = dropClauseOf(d);
  const attribution = `${flattenAndClip(d.item.angle, DROPPED_ATTRIBUTION_MAX_CHARS)} / ${flattenAndClip(d.item.kind, DROPPED_ATTRIBUTION_MAX_CHARS)}`;
  const fixed = DROPPED_DISCLOSURE_FRAME + clause.length + attribution.length + 1;
  // The item text gets the room the fixed parts leave, and never more than the
  // item clip — `maxChars` is a budget for the WHOLE line, which is the unit
  // the section's cap is measured in.
  const text = flattenAndClip(
    d.item.text,
    maxChars === undefined
      ? DROPPED_ITEM_MAX_CHARS
      : Math.max(1, Math.min(DROPPED_ITEM_MAX_CHARS, maxChars - fixed)),
  );
  return `- dropped: ${clause} — [${attribution}] ${text}`;
}

/**
 * The clause for one drop, with its deciding source(s) flattened and clipped.
 *
 * `DROP_CLAUSE[d.reason]` is looked up through a fallback rather than indexed
 * directly: `reason` reaches here from a cached investigation entry
 * (plan-investigation-guard.ts validates the shape, not the enum), so an
 * unknown value must degrade to a generic clause instead of throwing
 * `undefined is not a function` out of `draftSpec` and taking the whole run
 * down over one disclosure.
 */
function dropClauseOf(d: DroppedInvestigationItem): string {
  const against = flattenAndClip(d.against, DROPPED_SOURCE_MAX_CHARS);
  const sibling = flattenAndClip(d.sibling ?? "", DROPPED_SOURCE_MAX_CHARS);
  const make = DROP_CLAUSE[d.reason as (typeof PLAN_DROP_REASONS)[number]];
  if (make === undefined) {
    // Unknown reason: still disclose the item, still name what it clashed with.
    return `dropped from the investigation after clashing with "${against}"`;
  }
  return make({ ...d, against, ...(d.sibling === undefined ? {} : { sibling }) });
}

/**
 * #1132: the disclosure section for dropped investigation items ("" when none).
 *
 * #1383: bounded. A 56,738-char dropped section pushed one spec past the forge's
 * 65,536-char cap while every other section stayed small, so the body was
 * unfileable — this was the ONE section `draftSpec` never passed through `clip()`
 * or a count cap, and the reason `fitDraftToBudget`'s stage-1 re-render shrank
 * nothing (the two stages vary `maxItemsPerSection`/`itemClipChars`, which this
 * section does not read). Bounds live in plan-dropped-budget.ts and apply at BOTH fit
 * stages, which is what makes the cap land BEFORE the budget check rather than
 * after it.
 *
 * The bounds are render-only: which items are dropped, the kept/dropped partition
 * and the Open Questions this same producer emits are untouched — truncation
 * never changes what was dropped, only how much of the disclosure is shown. The
 * omitted count is reported, so the section can never silently shrink.
 *
 * #1383 lens round 2 — the second defeat closed: no line is ever emitted whole
 * past the room. The old loop exempted the first line (`shown > 0`), which made
 * a single oversized line a cap defeat. An item that does not fit whole is
 * CLIPPED to the remaining room instead of skipped or emitted full, and once
 * the room cannot hold even the minimum line the loop STOPS — it does not build
 * a disclosure for every remaining item that is guaranteed not to fit.
 *
 * `droppedSection(...).length <= DROPPED_SECTION_MAX_CHARS` holds exactly, with
 * no slack term; the test pins it at the cap itself with fixtures that reach it
 * (oversized angle, longest legal `settled` line, emoji item at the cut).
 *
 * @param onShownCount receives how many items actually rendered, so the caller
 * can persist the full list only when the body omitted some of it (#1383: the
 * durable artifact exists precisely because the section is bounded). Without
 * it, the caller would have to re-derive "was anything omitted" by counting
 * bullets in the rendered string — a second parser over the same bytes.
 */
export function droppedSection(
  dropped: DroppedInvestigationItem[],
  opts?: DroppedSectionOpts,
  onShownCount?: (shown: number) => void,
): string {
  if (dropped.length === 0) return "";
  // The heading bytes the section always emits are paid for first; `budget` is
  // what the bullets may occupy, with the omission line's worst case reserved
  // out of `room` so a break can never overshoot into it.
  const room = DROPPED_SECTION_MAX_CHARS - droppedSectionFrameChars();
  const budget = room - DROPPED_DISCLOSURE_RESERVE;
  // The loop runs TWICE: once to discover the cut point, once to lay the
  // bullets out against the note that cut point produces. A one-pass loop
  // cannot do this — the note's length depends on how many items were omitted,
  // and how many were omitted depends on where the loop broke. `droppedDisclosure`
  // is pure, so the second pass is deterministic and cheap (the items are
  // already in memory), and it is what lets the section fill its cap instead of
  // sitting DROPPED_DISCLOSURE_RESERVE bytes short of it — the reservation is a
  // safety net for the pass-2 measurement, not a permanent tax on every body.
  let shown = measure(dropped, budget);
  let note = shown < dropped.length ? omissionLine(dropped.length - shown, opts) : "";
  const fillTo = DROPPED_SECTION_MAX_CHARS - droppedSectionFrameChars() - note.length - 1;
  if (shown < dropped.length) {
    const roomier = measure(dropped, Math.max(budget, fillTo - 1));
    if (roomier > shown) {
      shown = roomier;
      note = omissionLine(dropped.length - shown, opts);
    }
  }
  onShownCount?.(shown);
  const body = dropped
    .slice(0, shown)
    .map((d) => droppedDisclosure(d))
    .join("\n");
  return `\n${DROPPED_SECTION_HEADING}\n\n${body}${note}\n`;
}

/**
 * How many items fit in `budget` bytes, one per line, counting the newline
 * separators — the pass-1 measurement the two-pass layout above needs. Stops at
 * the first line that does not fit, so it never builds a disclosure for the
 * items after the cut.
 */
function measure(dropped: DroppedInvestigationItem[], budget: number): number {
  let used = 0;
  let n = 0;
  for (const d of dropped) {
    const line = droppedDisclosure(d);
    const next = used + line.length + (n > 0 ? 1 : 0);
    if (next > budget) return n;
    used = next;
    n++;
  }
  return n;
}

/**
 * What the renderer knows about the rest of the run, beyond the items:
 * `reopened` is set when the gap gate surfaced unresolved open points (whose
 * section carries the full text of every conflict), and `artifactFile` is the
 * durable full-list file the pipeline wrote. Both change only the pointer in
 * the omission line — never what is rendered or omitted.
 */
export interface DroppedSectionOpts {
  reopened?: boolean;
  artifactFile?: string;
}

/**
 * Where the full list lives, chosen so the promise is true in every case:
 * a reopened run already carries the full conflict text in its own body, so
 * pointing at a local file on the planner's machine would be the false promise
 * round 1 made with `/runs`; otherwise the pipeline wrote the file this run and
 * naming it is checkable; and when the write failed (read-only or full
 * checkout) the line states counts and bounds and promises no location.
 */
function fullListPointer(opts: DroppedSectionOpts | undefined): string {
  if (opts?.reopened) {
    return `the ${DROPPED_REOPENED_HEADING.replace(/^## /, "")} section of this spec, which carries their full text`;
  }
  if (opts?.artifactFile) {
    // Repo-RELATIVE: the body is filed to a forge other people read, so an
    // absolute path would leak the planner's home directory into the issue and
    // still not resolve on their machine.
    return `${DROPPED_ARTIFACT_DIR}/${basenameOf(opts.artifactFile)}`;
  }
  return DROPPED_ARTIFACT;
}

/** The omission line: how many were not shown, the bounds that fired, and a
 * pointer that is true for this run. */
function omissionLine(omitted: number, opts?: DroppedSectionOpts): string {
  return `\n\n_… ${omitted} further dropped item(s) not shown (${DROPPED_ITEM_MAX_CHARS}-char item text, ${DROPPED_SOURCE_MAX_CHARS}-char deciding source, section capped at ${DROPPED_SECTION_MAX_CHARS} chars); the full list lives in ${fullListPointer(opts)}_`;
}

/** The filename half of a path, for a pointer that is portable and does not
 * disclose the writer's checkout location. */
function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * Replace the omission line's pointer in an already-rendered body (#1383).
 *
 * The pipeline cannot know the pointer when it drafts: whether the gap gate
 * reopens points, and whether the durable list actually got written, are both
 * decided after the fit and after the gate. Re-rendering the whole section at
 * that point would mean the filed body differs from the one the gate reviewed
 * in more than the disclosure; replacing the one line keeps the reviewed bytes
 * intact and makes the pointer true. Returns the body unchanged when no
 * omission line is present (nothing was omitted, so nothing needs pointing).
 *
 * The count is read from the line being replaced, NOT recomputed: the renderer
 * may have clipped the line itself to keep the section inside its cap, in which
 * case re-deriving it from the bullets would report fewer omissions than there
 * were. The caller passes the authoritative count for exactly that reason.
 */
export function repointDroppedOmission(
  body: string,
  reopened: boolean,
  artifactFile?: string,
  omittedCount?: number,
): string {
  const start = body.indexOf("\n\n_… ");
  if (start < 0) return body;
  const end = body.indexOf("_", start + 4);
  if (end < 0) return body;
  const current = body.slice(start, end + 1);
  if (!current.includes("further dropped item(s) not shown")) return body;
  const count = omittedCount ?? Number(/^_… (\d+) further/.exec(current.slice(4))?.[1] ?? "0");
  return `${body.slice(0, start)}${omissionLine(count, { reopened, artifactFile })}${body.slice(end + 1)}`;
}

/** The heading bytes the section emits, so the note's room is computed the same
 * way the renderer's is. */
function frameOf(): number {
  return droppedSectionFrameChars();
}
