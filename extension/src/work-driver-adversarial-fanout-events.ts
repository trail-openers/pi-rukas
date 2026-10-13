/**
 * work-driver-adversarial-fanout-events — the event batch one fan-out pass
 * appends (#485/#486). Split from work-driver-adversarial-fanout.ts
 * (AGENTS.md §12 file-size limit). Pure: outcomes in, WorkEvents out.
 */

import { type AdversarialOutcome, outcomeOf } from "./work-driver-adversarial-types.ts";
import type { WorkEvent } from "./workflow-state.ts";

/**
 * Append per-workstream events in deterministic order: dispatch-completed
 * / dispatch-failed, the per-round verdict records (#485), the
 * per-workstream outcome (#486), then branch-completed for N>1. On
 * re-entry the prior pass's SURVIVOR outcomes (approved / rejected /
 * skipped) are re-emitted here from their prior-outcome records (no
 * completionEvent / failureEvent / records — the events are synthetic,
 * carrying the prior verdict and `roundsExecuted: 0`), so the log stays
 * complete after the splice. The whole batch is spliced at `passStart`
 * — the previous pass's records' position on re-entry — so the fresh
 * records replace them and each workstream's rounds appear exactly once
 * (R1). The previous pass's stale records are dropped: a recovered
 * workstream's stale failure outcome must not sit side-by-side with its
 * fresh APPROVED outcome (W1).
 */
export function outcomeEvents(
  outcomes: readonly AdversarialOutcome[],
  multi: boolean,
): WorkEvent[] {
  const events: WorkEvent[] = [];
  for (const o of outcomes) {
    if (o.completionEvent) events.push(o.completionEvent);
    if (o.failureEvent) events.push(o.failureEvent);
    const recordsAt = Date.now();
    for (const r of o.records) {
      events.push({
        kind: "adversarial-round",
        at: recordsAt,
        workstreamId: multi ? o.id : undefined,
        round: r.round,
        status: r.status,
        verdictParsed: r.verdictParsed,
      });
    }
    if (multi) {
      const outcome = outcomeOf(o);
      events.push({
        kind: "adversarial-workstream-outcome",
        at: Date.now(),
        workstreamId: o.id,
        outcome,
        roundsExecuted: o.rounds,
        ...(o.errorTail && (o.infra || o.threw) ? { errorTail: o.errorTail } : {}),
        ...(outcome === "approved" && o.passFindings ? { findings: o.passFindings } : {}),
      });
    }
    if (o.branchEvent) events.push(o.branchEvent);
  }
  return events;
}
