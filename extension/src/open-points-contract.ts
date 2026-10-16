/**
 * open-points-contract — the contract for the "Open points" section of a filed issue (#1151).
 *
 * The /plan gap gate writes this section (plan-gap-disclosure.ts) when a CRITICAL
 * gap is still unresolved at its iteration cap. The /work intent gate reads it
 * back (open-points-reader.ts) and decides whether the issue is
 * buildable. Both sides take the heading and severity from here, so a rename on
 * one side cannot silently stop the other from reading what it wrote.
 *
 * Reading rules the intent gate applies:
 *   - every unresolved CRITICAL point parks the cycle, whatever its topic (#1187).
 *     No keyword or topic classification decides it: the park reason is
 *     `unresolved-critical-open-point`.
 *   - a point is answered only when `[RESOLVED]` appears unemphasised, right after
 *     the severity tag on the bullet's own first line (`- [CRITICAL][RESOLVED] …` or
 *     `- [CRITICAL] [RESOLVED] …`). `**[RESOLVED]**` does not count and parks.
 *     Answer the point in the issue body, then re-run with `/work N --restart`.
 *   - any other line in the section that is not a plain bullet, checkbox or link
 *     bullet parks as unparsed, rather than being ignored (open-points-reader.ts).
 *   - the one intro sentence below is prose the WRITER emits, so the READER skips it
 *     verbatim (#1187 fix round 1): without that exemption a gap-gate-filed issue can
 *     never be cleared by `[RESOLVED]`, because the intro parks after every point is answered.
 */

/** Heading of the open-points section the gap gate renders. */
export const OPEN_POINTS_HEADING = "Open points (unresolved at the gap-gate cap)";

/**
 * The intro sentence the gap gate writes under the heading (plan-gap-disclosure.ts).
 *
 * Shared constant, not a copy: it is the only non-bullet line the writer itself emits,
 * so it is the only prose line the reader exempts. The reader compares it against
 * `flattenIssueText` output; the writer puts it on one line, so the two agree.
 */
export const OPEN_POINTS_INTRO =
  "The gap gate reached its iteration cap with these CRITICAL points still unresolved. The issue is filed so they are visible; the /work intent gate decides whether it is buildable.";

/** The severity tag of a bullet that gates the intent resolver. */
export const CRITICAL_SEVERITY = "CRITICAL";

/**
 * Every severity word a bullet may lead with. Only {@link CRITICAL_SEVERITY} gates;
 * the others are read and set aside (#1187). Declared next to the tag that gates so
 * the reader's near-miss rule and the writer's vocabulary cannot drift apart.
 */
export const SEVERITY_WORDS: readonly string[] = [CRITICAL_SEVERITY, "HIGH", "MEDIUM", "LOW"];

/**
 * Escape a literal for embedding in a RegExp source.
 *
 * The heading is a piece of author-visible prose the writer owns; the reader must match
 * it *as text*, so every regex metacharacter in it — the parentheses of "(unresolved at
 * the gap-gate cap)" — is escaped rather than interpreted. Kept here rather than in a
 * reader module so the derivation in {@link openPointsHeadingPattern} is the only place
 * the heading and its matcher meet.
 */
export function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The source of the ATX matcher for the exact {@link OPEN_POINTS_HEADING}.
 *
 * Derived from the constant, never a copy of it: a rename on the writer's side changes
 * the matcher the reader uses, so the two cannot silently disagree (a copied literal
 * is how the reader kept matching a heading the contract no longer wrote). Leading
 * spaces, any `#` count and trailing hashes are tolerated; nothing else is, so the
 * settlement's "no cross-section scan" holds exactly — a near-miss heading opens no
 * section.
 */
export function openPointsHeadingPattern(): string {
  return `^ {0,3}#{1,6}[ \t]+${escapeRegExpLiteral(OPEN_POINTS_HEADING)}[ \t]*#*[ \t]*$`;
}
