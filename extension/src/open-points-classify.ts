/**
 * open-points-classify — what one list item of the Open points section is.
 *
 * The seam with open-points-reader.ts: the reader owns the LINE structure of the section
 * (where it starts and ends, fences, continuation, bounds), this module owns the TEXT of
 * one item's first line — its severity tag, whether a CRITICAL point is answered, and
 * which near-miss tags park. The reader hands every item here flattened and with any task
 * checkbox removed, so the rules below read text, never markdown line structure.
 */
import { CRITICAL_SEVERITY, SEVERITY_WORDS } from "./open-points-contract.ts";

/** The kinds of entry a reading stores: an unresolved point, a resolved one, or a blocking line. */
export type EntryKind = "point" | "resolved" | "parked";

/**
 * The disposition {@link classifyItem} reads from one item. A `plain` item contributes no
 * text to a reading, so it is not an {@link EntryKind} — the reader drops it uncounted.
 */
export type ItemDisposition = EntryKind | "plain";

/** Case-folded token without spaces or hyphens: `[CRIT ICAL]` and `[critical]` both fold to `critical`. */
function foldToken(token: string): string {
  return token.toLowerCase().replace(/[\s-]/g, "");
}

/** Tag-like: folds to a severity word without being that word exactly. Such a tag parks; it never passes. */
function isTagLike(token: string): boolean {
  return SEVERITY_WORDS.some((word) => word !== token && word.toLowerCase() === foldToken(token));
}

/**
 * Whether any bracketed token in `text` case-folds to CRITICAL.
 *
 * One place for the anywhere-scan, so the fall-through at the end of {@link classifyItem}
 * and the link-bullet exemption cannot disagree about what a CRITICAL-shaped tag is.
 */
function hasCriticalToken(text: string): boolean {
  return [...text.matchAll(/\[([^\]]*)\]/g)].some(
    (m) => foldToken(m[1] ?? "") === foldToken(CRITICAL_SEVERITY),
  );
}

/**
 * `[RESOLVED]` later on the line, after the topic: whitespace on both sides, then a
 * separator, then answer text. The separator is what tells an answer from a topic that
 * merely mentions the token, and the whitespace keeps an emphasised `*[RESOLVED]*` out.
 */
const LATER_RESOLVED = /(?<=\s)\[RESOLVED\]\s+[-–—:]\s*\S/;

/** Whether the text after a `[CRITICAL]` tag answers the point; `parked` for an empty right-after answer. */
function criticalDisposition(after: string): ItemDisposition {
  const answer = after.match(/^\s*\[RESOLVED\](.*)$/);
  if (answer !== null) return (answer[1] ?? "").trim() ? "resolved" : "parked";
  return LATER_RESOLVED.test(after) ? "resolved" : "point";
}

/**
 * The disposition of one list item, from its flattened first line with any task checkbox
 * removed. Severity is recognised only at the start of the text: a tag behind emphasis or
 * strikethrough is not read, and a CRITICAL-shaped tag anywhere else in the text parks.
 */
export function classifyItem(text: string): ItemDisposition {
  const lead = text.match(/^\[([^\]]*)\]/);
  if (lead) {
    const token = lead[1] ?? "";
    const after = text.slice(lead[0].length);
    if (token === CRITICAL_SEVERITY) return criticalDisposition(after);
    if (SEVERITY_WORDS.includes(token)) return "plain";
    // The tag-like check runs BEFORE the link exemption: the writer puts ` — proposed: …`
    // between the tag and anything else, so a near-miss tag is never followed by `(` in a
    // rendered section, and `- [CRIT ICAL](https://x) …` must not read as an ordinary note.
    if (isTagLike(token)) return "parked";
    // A markdown link is an ordinary bullet. Any other bracketed token is one we cannot read.
    // An EXACT severity tag is not exempted by a following link: the tag wins, fail closed.
    // The link exemption is not a blind pass either: the anywhere-CRITICAL scan runs on the
    // whole bullet first, so a tag hidden inside link syntax —
    // `- [x](https://e/#[CRITICAL] who)` — parks instead of reading as an ordinary note.
    if (after.startsWith("(")) return hasCriticalToken(text) ? "parked" : "plain";
    return "parked";
  }
  if (/^\W*critical\b/i.test(text)) return "parked";
  return hasCriticalToken(text) ? "parked" : "plain";
}
