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
 *   - only bullets under the heading, and only those tagged `[CRITICAL]`, gate;
 *   - an authentication / authorization / secrets / permissions point parks the
 *     cycle with reason `security-open-point`; any other point caps a proceed at
 *     `proceed-with-assumptions`;
 *   - a point the author has answered no longer gates. A bullet is resolved when
 *     it carries `[RESOLVED]` anywhere (e.g. `- [CRITICAL][RESOLVED] …`), or when
 *     it contains a strikethrough `~~…~~` span. Answer the point in the issue
 *     body, mark it resolved, and re-run with `/work N --restart`.
 */

/** Heading of the open-points section the gap gate renders. */
export const OPEN_POINTS_HEADING = "Open points (unresolved at the gap-gate cap)";

/** The severity tag of a bullet that gates the intent resolver. */
export const CRITICAL_SEVERITY = "CRITICAL";
