/**
 * work-driver-intent-questions — decide which spec open questions block.
 *
 * Owns the "nothing blocking" placeholder rule: an open question that reads
 * as an explicit "none" is not a blocking question, including the #996
 * parenthesised "(none — …)" shape resolvers emit when the section holds a
 * single bullet with a trailing explanation.
 */

/**
 * Whether an open-question bullet reads as a "nothing blocking" placeholder.
 *
 * A true placeholder is the keyword *as the answer*, not the keyword as the
 * first word of a genuine sentence. The keyword must be followed only by:
 *   - nothing ("None", "N/A", "(none)")
 *   - punctuation ("None.", "(None blocking.)")
 *   - an em-dash explanation ("None — the mechanism is confirmed")
 *   - the fixed phrase "blocking" ("None blocking", "Nothing blocking")
 *   - the fixed phrase "open questions" ("No open questions")
 *
 * A keyword followed by any other word ("No single owner…", "Nothing in the
 * issue says…", "No tests currently…") is a genuine open question and is
 * NOT discounted. This is the #996 adversarial-review boundary: the pre-fix
 * regex `^(none|no|nothing|n\/a)\\b` treated every sentence beginning with
 * "No"/"Nothing" as a placeholder, silently licensing the #397 override to
 * turn a real park into `proceed-with-assumptions`.
 */
function isNonePlaceholder(q: string): boolean {
  // Strip leading markdown/paren markers (whitespace, bold, backticks, open-paren)
  // and trailing ones (closing paren, bold, backtick) so the keyword's true
  // neighbours are visible. `**None**` → `None`, `(none)` → `none`.
  const stripped = q
    .replace(/^[\s*_`(`]+/, "")
    .replace(/[)\]]+[\s*_`]*$/, "")
    .trim();
  const m = stripped.match(/^(none|no|nothing|n\/a)\b(.*)$/i);
  if (!m) return false;
  // Strip leading/trailing markdown markers from `rest` so the keyword's true
  // neighbours are visible. `**None** — explanation` → rest=`** — explanation` → `— explanation`.
  const rest = (m[2] ?? "")
    .replace(/^[\s*_`]+/, "")
    .replace(/[\s*_`]+$/, "")
    .trim();
  // Keyword is the whole token → placeholder.
  if (rest === "") return true;
  // Only trailing punctuation ("None.", "None,", "None.)")
  if (/^[\.,)\]]+$/.test(rest)) return true;
  // Em-dash explanation: "None — the mechanism is confirmed"
  if (/^—/.test(rest)) return true;
  // Fixed phrase "blocking": "None blocking", "Nothing blocking", "None blocking. …"
  if (/^blocking\b/i.test(rest)) return true;
  // Fixed phrase "open questions": "No open questions"
  if (/^open questions\b/i.test(rest)) return true;
  // Anything else (a noun/verb phrase) is a genuine open question → NOT a placeholder.
  return false;
}

export function blockingQuestions(qs: string[]): string[] {
  return qs.filter((q) => !isNonePlaceholder(q));
}
