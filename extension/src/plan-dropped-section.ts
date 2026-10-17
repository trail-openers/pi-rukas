/**
 * plan-dropped-section — the bounded renderer for the `## Dropped investigation
 * items` disclosure (#1383).
 *
 * Extracted from plan-draft-conflicts.ts along the 500-line seam (AGENTS.md
 * §12); the drop DECISIONS (filterInvestigationConflicts, DROP_CLAUSE,
 * droppedDisclosure) stay there — this file only decides how much of an
 * already-decided disclosure renders.
 */

import { type DroppedInvestigationItem, droppedDisclosure } from "./plan-draft-conflicts.ts";
import {
  DROPPED_ARTIFACT,
  DROPPED_DISCLOSURE_RESERVE,
  DROPPED_ITEM_MAX_CHARS,
  DROPPED_SECTION_HEADING,
  DROPPED_SECTION_MAX_CHARS,
} from "./plan-dropped-budget.ts";

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
 */
export function droppedSection(dropped: DroppedInvestigationItem[]): string {
  if (dropped.length === 0) return "";
  const lines: string[] = [];
  // Headroom for the omission line an early break produces, so the total can
  // never exceed the cap by overshooting into it. A single line longer than the
  // whole budget still ships — a truncated line is better than no disclosure.
  const room = DROPPED_SECTION_MAX_CHARS - `\n${DROPPED_SECTION_HEADING}\n\n`.length - 1;
  let used = 0;
  let shown = 0;
  for (const d of dropped) {
    const line = droppedDisclosure(d);
    const next = used + line.length + (shown > 0 ? 1 : 0);
    if (shown > 0 && next + DROPPED_DISCLOSURE_RESERVE > room) break;
    lines.push(line);
    used = next;
    shown++;
  }
  const omitted = dropped.length - shown;
  const note =
    omitted > 0
      ? `\n\n_… ${omitted} further dropped item(s) not shown (${DROPPED_ITEM_MAX_CHARS}-char item text, section capped at ${DROPPED_SECTION_MAX_CHARS} chars); the full list lives in ${DROPPED_ARTIFACT}_`
      : "";
  return `\n${DROPPED_SECTION_HEADING}\n\n${lines.join("\n")}${note}\n`;
}
