/**
 * work-driver-intent-questions — decide which spec open questions block.
 *
 * Owns the "nothing blocking" placeholder rule: an open question that reads
 * as an explicit "none" is not a blocking question, including the #996
 * parenthesised "(none — …)" shape resolvers emit when the section holds a
 * single bullet with a trailing explanation.
 */

/**
 * An open question that reads as an explicit "nothing blocking" is not one.
 *
 * Resolvers write `- **None blocking** — mechanism is confirmed with executed
 * evidence` rather than emitting an empty section. Counting that as a blocking
 * question is how a fully-resolved spec looks unresolved.
 */
/**
 * Whether an open-question bullet reads as a "nothing blocking" placeholder.
 *
 * Resolvers wrap this in markdown: bold, backticks, and — load-bearing for
 * #996 — a leading paren when the question is a single bullet with a
 * trailing explanation, e.g. `(none — the residual-gap MEDIUM items are
 * resolved by the acceptance criteria above; the LOW items are implementer
 * details)`. The prior character class `\s*_\`` did not include `(`, so that
 * one shape was counted as a blocking question and `specIsComplete` (and
 * therefore the #397 override) failed on an otherwise complete spec.
 */
function isNonePlaceholder(q: string): boolean {
  return /^[\s*_`(`]*(none|no|nothing|n\/a)\b/i.test(q);
}

export function blockingQuestions(qs: string[]): string[] {
  return qs.filter((q) => !isNonePlaceholder(q));
}
