/**
 * review-findings-severity — the #1129 severity and trigger rules of the
 * findings memory, pure (no I/O). review-findings-store.ts applies them when a
 * round is recorded; lens-review-converge.ts applies the downgrade they make
 * eligible when the verdict is computed.
 *
 * The invariant: the store NEVER writes a downgraded severity. A stored row's
 * severity only rises, and its trigger is sticky. The round-2 downgrade
 * (MEDIUM without a trigger → LOW) is a verdict-time judgement, applied only to
 * a finding `downgradeEligible` admits, so a row cannot be laundered to LOW by
 * a trigger-less re-report.
 */

import type { Severity } from "./lens-review-format.ts";
import type { Finding } from "./lens-review-types.ts";
import type { StoredFinding } from "./review-findings-file.ts";

const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** The severity a row keeps after a re-report: the higher of stored and incoming. */
export function reportedSeverity(stored: Severity, incoming: Severity): Severity {
  return SEVERITY_RANK[incoming] > SEVERITY_RANK[stored] ? incoming : stored;
}

/** The trigger a row keeps after a re-report: once seen it is kept; a re-report without one never clears it. */
export function reportedTrigger(stored: string | undefined, incoming: string | undefined) {
  return incoming ?? stored;
}

/**
 * Eligible for the round-2 downgrade: the row was CREATED under #1129
 * (`triggerTracked`, set only on insert), has never had a trigger, and is
 * stored at exactly MEDIUM. Legacy rows (no `triggerTracked`) never qualify.
 */
export function downgradeEligible(
  row: Pick<StoredFinding, "triggerTracked" | "trigger" | "severity">,
): boolean {
  return row.triggerTracked === true && row.trigger === undefined && row.severity === "MEDIUM";
}

/** The finding as the store reports it: the stored severity and trigger, never a downgrade record. */
export function effectiveFinding(
  f: Finding,
  kept: { severity: Severity; trigger?: string },
): Finding {
  if (f.severity === kept.severity && f.trigger === kept.trigger) return f;
  return { ...f, severity: kept.severity, trigger: kept.trigger };
}
