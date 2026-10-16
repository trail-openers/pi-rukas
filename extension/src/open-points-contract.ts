/**
 * open-points-contract — the contract for the "Open points" section of a filed issue (#1151).
 *
 * The /plan gap gate writes this section (plan-gap-disclosure.ts) when a CRITICAL
 * gap is still unresolved at its iteration cap. The /work intent gate reads it
 * back (work-driver-intent-criticality.ts) and decides whether the issue is
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
 *     bullet parks as unparsed, rather than being ignored (work-driver-intent-criticality.ts).
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
