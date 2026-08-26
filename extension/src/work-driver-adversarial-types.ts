/**
 * work-driver-adversarial-types — the shared adversarial-gate types
 * (AdversarialOutcome / round records) + the per-workstream retry budget,
 * split from work-driver-adversarial-fanout.ts (AGENTS.md §12 file-size
 * limit). The fan-out module and its consumers (work-driver-adversarial.ts,
 * work-driver-adversarial-capkill.ts, work-driver-adversarial-reentry.ts)
 * import them from here.
 */

import type { WorkEvent } from "./workflow-state.ts";

/** #486 — the driver's per-workstream adversarial retry budget. Matches the #308 router's TRANSIENT_MAX_RETRIES shape (2 retries = up to 3 total attempts). */
export const ADVERSARIAL_PER_WS_MAX_RETRIES = 2;

export type AdversarialRoundStatus =
  | "CRITICAL_ISSUES_FOUND"
  | "ISSUES_FOUND"
  | "MINOR_OBSERVATIONS"
  | "APPROVED";

export interface AdversarialRoundRecord {
  round: number;
  status: AdversarialRoundStatus;
  verdictParsed: boolean;
}

export interface AdversarialOutcome {
  id: string;
  ok: boolean;
  /** Reviews this workstream actually executed. */
  rounds: number;
  /** #485 — per-round verdict records, persisted verbatim. */
  records: AdversarialRoundRecord[];
  /** #298 — the loop died on infrastructure: no verdict exists. */
  infra: boolean;
  /** The loop threw before any review ran. */
  threw: boolean;
  /** #286 — empty diff, loop skipped (counts as a pass). */
  skipped: boolean;
  /** #486 — a prior run's infra-failure outcome for this workstream. */
  priorInfra: boolean;
  /** #486 — a prior run's VERDICT outcome (approved / rejected / skipped-empty-diff). Final and NOT re-run on re-entry; the event loop below re-emits the prior verdict from this record so the log stays complete after the splice replaces the prior pass's batch. */
  priorVerdict?: "approved" | "rejected" | "skipped-empty-diff";
  rejectionText?: string;
  /** Non-blocking findings outstanding when this workstream passed. */
  passFindings?: string;
  errorTail?: string;
  /** #543 — a loop / token-budget cap kill, threaded from the inner spawn. */
  killCause?: "loop" | "token-budget";
  /** #543 — the F1 streak evidence for a loop kill, threaded from the inner
   * spawn's DispatchResult so the driver can persist `capEvidence`. */
  loopEvidence?: { tool: string; count: number };
  /** #543 — the F6 budget + used tokens for a token-budget kill, threaded
   * for the same reason. */
  tokenBudget?: { budget: number; used: number };
  completionEvent?: WorkEvent;
  failureEvent?: WorkEvent;
  branchEvent?: WorkEvent;
}
