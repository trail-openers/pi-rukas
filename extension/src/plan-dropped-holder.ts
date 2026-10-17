/**
 * plan-dropped-holder — where the drop DECISIONS are published so the pipeline
 * can persist what the bounded section could not render (#1383).
 *
 * `draftSpec` computes the dropped list and renders it through
 * `plan-dropped-section.ts`; the driver is the one that owns the repo root and
 * therefore owns writing `.pi/plan-dropped/`. Threading the items back out of
 * `draftSpec`'s return value would widen a twelve-positional-arg signature that
 * `plan-driver-phase3.ts` already documents as the reason it exists, and the
 * corrective re-draft calls it a second time with the same list. So the list is
 * published here, once per render, and the driver reads it once after the
 * fitter — the same shape the plan-reporter preflight seam uses.
 *
 * Module-level state, which is honest about what it is: one /plan pipeline runs
 * per Pi process at a time, and the value written is the list that produced the
 * body currently in flight. A concurrent second run would have to be a second
 * process, which is already true of every other plan seam here.
 */

import type { DroppedInvestigationItem } from "./plan-draft-conflicts.ts";
import { droppedSection } from "./plan-dropped-section.ts";

/** The dropped list from the most recent `draftSpec` render, plus what it rendered. */
export interface LastDroppedRender {
  items: DroppedInvestigationItem[];
  shown: number;
}

let last: LastDroppedRender | null = null;

/** Called by `draftSpec` after the dropped section renders. */
export function publishDroppedRender(items: DroppedInvestigationItem[], shown: number): void {
  last = items.length > 0 ? { items, shown } : null;
}

/** Read by the driver to decide whether (and what) to persist. */
export function lastDroppedRender(): LastDroppedRender | null {
  return last;
}

/**
 * `draftSpec`'s call site: render the section AND publish what rendered, in one
 * expression so the two cannot drift apart (a body rendered without publishing
 * would silently skip the durable artifact; a publish without rendering would
 * write a file no body points at). Kept here rather than inline in plan-draft.ts
 * to leave that module's size at the 500-line seam (AGENTS.md §12).
 */
export function droppedSectionWithHolder(dropped: DroppedInvestigationItem[]): string {
  let shown = 0;
  const section = droppedSection(dropped, undefined, (n) => {
    shown = n;
  });
  publishDroppedRender(dropped, shown);
  return section;
}
