/**
 * open-points-contract — the contract for the "Open points" section of a filed issue (#1151).
 *
 * The /plan gap gate writes this section (plan-gap-disclosure.ts) when a CRITICAL
 * gap is still unresolved at its iteration cap. The /work intent gate reads it
 * back (work-driver-intent-criticality.ts) and decides whether the issue is
 * buildable. Both sides take the heading and severity from here, so a rename on
 * one side cannot silently stop the other from reading what it wrote.
 */

/** Heading of the open-points section the gap gate renders. */
export const OPEN_POINTS_HEADING = "Open points (unresolved at the gap-gate cap)";

/** The severity tag of a bullet that gates the intent resolver. */
export const CRITICAL_SEVERITY = "CRITICAL";
