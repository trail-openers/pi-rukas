/**
 * text-flatten — the one sanitiser for untrusted text that lands in a single
 * evidence or handoff line (#1171).
 *
 * Issue bodies and provider error messages are untrusted: they can carry line
 * breaks that forge a new bullet, bidirectional overrides that reorder what a
 * reader sees, and zero-width characters that hide a word. `flattenIssueText`
 * makes such text one inert line; `flattenAndClip` adds a code-point-safe length
 * cap. Both quotedIssueText (intent open points) and fetchFailureReason (explore)
 * use this module, so the two cannot drift apart.
 *
 * Control characters, U+2028 and U+2029 become a space (one run, one space), so
 * they separate words. Bidi controls and zero-width characters are removed
 * outright, so they cannot split or hide a word.
 */

/** Control characters and the Unicode line/paragraph separators: each run becomes one space. */
const LINE_BREAKING = /[\p{Cc}\u2028\u2029]+/gu;

/** Bidi overrides/isolates, zero-width spaces and joiners, and the BOM: removed. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/** One line of plain text: no control, separator, bidi or zero-width characters, collapsed whitespace. */
export function flattenIssueText(text: string): string {
  return text.replace(INVISIBLE, "").replace(LINE_BREAKING, " ").replace(/\s+/g, " ").trim();
}

/** Clip by code point, so a surrogate pair is never split into a lone half. */
// Flattened first; a clipped value ends in "…".
export function flattenAndClip(text: string, max: number): string {
  const flat = flattenIssueText(text);
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}
