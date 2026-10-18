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
  /** #1114 — a parsed non-terminal verdict: this workstream goes back to develop as a fix pass. */
  fixRequested?: boolean;
  /** #1114 — the reviewer's findings for a fix pass (the develop prompt's data). */
  fixFindings?: string;
  /** Non-blocking findings outstanding when this workstream passed. */
  passFindings?: string;
  errorTail?: string;
  /** #79 — identical provider failures in a row the loop already saw; ≥2 is not retried in-step. */
  providerRepeats?: number;
  /** #543 — a loop / token-budget cap kill, threaded from the inner spawn.
   * #1243 — widened to the watchdog kills too, for the RETRY LADDER only (see
   * `retryLadderKillCause`): a `provider-severed` classification that is really
   * a self-kill used to buy the minutes floor, because the classifier was never
   * given the cause. Cap-kill PARKING still reads only loop / token-budget —
   * `capHitForCapKill` narrows on the value, so widening the field cannot
   * promote a watchdog kill into a fixed-literal cap. */
  killCause?:
    | "timeout"
    | "inactivity"
    | "tool-inactivity"
    | "abort"
    | "loop"
    | "token-budget"
    | "plan-timeout"
    | "child-bound"
    | "no-progress"
    | "stuck-tool";
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

/** The `outcome` a per-workstream event records. */
export type WorkstreamOutcome = Extract<
  WorkEvent,
  { kind: "adversarial-workstream-outcome" }
>["outcome"];

/** The outcome label one workstream's event records. Total: every outcome has exactly one. */
export function outcomeOf(o: AdversarialOutcome): WorkstreamOutcome {
  if (o.priorVerdict) return o.priorVerdict;
  if (o.fixRequested) return "fix-requested";
  if (o.skipped) return "skipped-empty-diff";
  if (o.threw) return "dispatch-failed";
  if (o.infra) return "infra-failure";
  return o.ok ? "approved" : "rejected";
}
