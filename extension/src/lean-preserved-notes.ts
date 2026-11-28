/**
 * lean-preserved-notes — the clause formatters the `specify`/`challenge` step prints in its reason,
 * kept outside the lean tree.
 *
 * The bounds are the step's own: a chatty runner must not drown an outcome reason, so every note family is
 * capped and clipped the same way. Pure string work, so the engine keeps only the call and the cap stays
 * in one place beside the rule it bounds.
 */

/** How many per-file notes an outcome reason carries before it says `(+N more)`. */
const NOTE_CAP = 8;
/** How long one note's detail may run before the reason clips it. */
const NOTE_DETAIL_MAX = 200;

/** A note's detail, clipped: one chatty runner must not drown the reason. */
export function noteClip(detail: string): string {
  const one = detail.replace(/\s+/g, " ").trim();
  return one.length > NOTE_DETAIL_MAX ? `${one.slice(0, NOTE_DETAIL_MAX)}…` : one;
}

/** A capped `label N: a; b; c` clause — every note family needs the same bound. */
export function noteClause(label: string, notes: string[]): string {
  if (notes.length === 0) return "";
  const shown = notes.slice(0, NOTE_CAP).map(noteClip);
  const more = notes.length - shown.length;
  return `${label} ${notes.length}: ${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** A dropped row as the boundary reports it: the criterion, the path if it had one, the reason. */
export interface DropLabel {
  criterionId: string;
  path?: string;
  reason: string;
}

/** The attributed form of one drop, `<criterionId> <path>: <reason>`, path omitted when there is none. */
export function droppedLabel(d: DropLabel): string {
  return `${d.criterionId}${d.path === undefined ? "" : ` ${d.path}`}: ${d.reason}`;
}

/**
 * A `dropped N (…) — a; b; c` clause with NO leading space: each call site supplies its own separator.
 */
export function dropNote(dropped: DropLabel[]): string {
  if (dropped.length === 0) return "";
  const parts = dropped.slice(0, NOTE_CAP).map((d) => noteClip(droppedLabel(d)));
  const more = dropped.length - parts.length;
  return `dropped ${String(dropped.length)}${more > 0 ? ` (+${more} more)` : ""} — ${parts.join("; ")}`;
}
