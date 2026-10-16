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
 * they separate words. Format characters (Unicode category Cf: bidi controls,
 * zero-width characters, soft hyphen, word joiner) are removed outright, so they
 * cannot split or hide a word.
 *
 * `redactThenBound` is the sibling for text that is STORED as well as rendered:
 * one redact-then-clip, so a length cap can never cut a credential into a fragment
 * no pattern recognises.
 */

import { redactSecrets } from "./secret-patterns.ts";

/** Control characters and the Unicode line/paragraph separators: each run becomes one space. */
const LINE_BREAKING = /[\p{Cc}\u2028\u2029]+/gu;

/** Format characters (Cf): bidi overrides/isolates, zero-width, soft hyphen, word joiner, BOM. Removed. */
const INVISIBLE = /\p{Cf}/gu;

/** One line of plain text: no control, separator, bidi or zero-width characters, collapsed whitespace. */
export function flattenIssueText(text: string): string {
  return text.replace(INVISIBLE, "").replace(LINE_BREAKING, " ").replace(/\s+/g, " ").trim();
}

/**
 * Redact every secret span, THEN bound by code point (#1187 fix round 4).
 *
 * The order is the whole point: clipping first can cut a token into a fragment no
 * pattern recognises, so the fragment survives into the handoff or the PR body (the
 * same reasoning as `redactClip` in decision-log.ts). This is the ONE normaliser for
 * text the open-point gate stores or renders — the reader's entries, the artifact
 * reader's restored strings and the handoff's renderable list all call it, so a bound
 * cannot be applied in one place and forgotten in another. Code points are counted, so
 * a bound never leaves half a surrogate pair behind.
 *
 * `clipped` says whether the bound actually trimmed, which is how callers append a
 * marker without re-measuring the string they were just handed: a caller that compares
 * the returned length against its own bound re-derives a fact the function already
 * decided, and on this runtime that comparison does not survive inlining — the clipped
 * case silently loses its marker. The flag is the return value; nothing re-tests it.
 */
export function redactThenBound(text: string, max: number): { text: string; clipped: boolean } {
  const chars = Array.from(redactSecrets(text).text);
  return chars.length > max
    ? { text: chars.slice(0, max).join(""), clipped: true }
    : { text: chars.join(""), clipped: false };
}

/**
 * Flatten, then clip by code point so a surrogate pair is never split into a lone half.
 * A clipped value ends in "…".
 */
export function flattenAndClip(text: string, max: number): string {
  const flat = flattenIssueText(text);
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}
