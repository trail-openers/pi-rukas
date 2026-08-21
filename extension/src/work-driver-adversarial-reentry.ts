/**
 * work-driver-adversarial-reentry — the re-entry mechanics for the
 * adversarial gate (#485/#486), extracted from
 * work-driver-adversarial-fanout.ts (AGENTS.md §12 file-size limit).
 *
 * When the driver re-enters the adversarial step after a prior pass
 * recorded per-workstream events (a NO-VERDICT outcome that the step-level
 * router re-ran), the previous pass's per-round records and workstream
 * outcomes are STALE: a recovered workstream's fresh outcome supersedes
 * them, and keeping both copies in the log duplicates the round records
 * (R1) and leaves a stale failure outcome in the N>1 aggregate (W1).
 *
 * This module provides the pure primitives the fan-out uses:
 *
 * - `mergeFreshOutcomes` — merges a fresh pass's per-workstream outcomes
 *   into the running aggregate, replacing stale outcomes for the same
 *   workstream (T6/W1: a recovered workstream's fresh APPROVED
 *   supersedes its stale infra-failure).
 *
 * - `reentryPassBatchSpan` — the [start, end) span of the previous pass's
 *   per-workstream event batch in the log (R1: the fresh batch splices
 *   over it, so records appear exactly once).
 *
 * Leaf module — no dependency on any work-driver-<step>.ts handler.
 */

import type { DispatchResult } from "./types.ts";
import type {
  AdversarialOutcome,
  AdversarialRoundRecord,
} from "./work-driver-adversarial-fanout.ts";
import { classifyFailureCause } from "./work-driver-failure-taxonomy.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/**
 * Merge a fresh pass's outcomes into the running aggregate, replacing
 * stale outcomes for the same workstream (T6/W1: a recovered
 * workstream's fresh APPROVED supersedes its stale infra-failure).
 * Returns outcomes in the original workstream order.
 */
export function mergeFreshOutcomes(
  existing: AdversarialOutcome[],
  fresh: AdversarialOutcome[],
  ids: string[],
): AdversarialOutcome[] {
  const byId = new Map<string, AdversarialOutcome>();
  for (const o of existing) byId.set(o.id, o);
  for (const o of fresh) byId.set(o.id, o);
  return ids.map((id) => byId.get(id)).filter((o): o is AdversarialOutcome => o !== undefined);
}

/**
 * The round this loop's reply describes, as data: the loop's own round
 * table when it carried one (#485), else the "after round N" marker on
 * approved/rejected headlines. An UNPARSEABLE reply returns undefined
 * instead of a confident default — the #485 defect was a guess of 3 for an
 * infra-failure string that contained neither marker, rendered as "3
 * adversarial round(s), all rejected".
 */
export function roundsFromReply(result: DispatchResult): number | undefined {
  const table = result.adversarialRounds ?? [];
  if (table.length > 0) {
    return Math.max(...table.map((r) => r.round));
  }
  const m = result.text.match(/after round (\d+)/);
  if (m?.[1]) return Number.parseInt(m[1], 10);
  const plural = result.text.match(/after (\d+) rounds/);
  return plural?.[1] ? Number.parseInt(plural[1], 10) : undefined;
}

/**
 * The per-round records to persist. The loop's table is authoritative; the
 * fallback reconstructs it for injected fakes and pre-#485 callers, marking
 * the reconstruction honest (`verdictParsed: false`) rather than inventing a
 * parse the reviewer never made.
 */
export function roundsRecords(result: DispatchResult): AdversarialRoundRecord[] {
  const fromData = result.adversarialRounds ?? [];
  const records = fromData.length > 0 ? [...fromData] : [];
  if (records.length === 0) {
    // #485 — the loop's reply says which rounds ran; that is what the
    // per-round log should count. (Using the loop's roundsExecuted here
    // instead would collapse to the no-verdict count and record ZERO
    // rounds for every clean pass.)
    const total = roundsFromReply(result);
    if (total !== undefined) {
      for (let round = 1; round <= total; round++) {
        records.push(
          round === total
            ? {
                round,
                status: result.loopOutcome === "rejected" ? "CRITICAL_ISSUES_FOUND" : "APPROVED",
                verdictParsed: false,
              }
            : { round, status: "ISSUES_FOUND", verdictParsed: false },
        );
      }
    }
  }
  return records;
}

/**
 * #486 — whether a failed workstream's outcome is a TRANSIENT infra
 * failure eligible for the in-step retry. A `threw` outcome is only
 * transient when the cause is `provider-severed` (a network blip); any
 * other cause is a genuine failure that the retry cannot fix.
 */
export function isTransientAdversarialOutcome(o: AdversarialOutcome): boolean {
  if (!o.ok && o.infra) {
    const cls = classifyFailureCause({
      kind: "dispatch-failed-provider",
      providerMessage: o.errorTail,
    });
    return cls.shouldRetry;
  }
  if (!o.ok && o.threw) {
    const cls = classifyFailureCause({ kind: "dispatch-failed", errorTail: o.errorTail });
    return cls.shouldRetry && cls.cause === "provider-severed";
  }
  return false;
}

/**
 * #486 — classify a workstream's failure for the taxonomy's backoff
 * computation. The shape of the event (infra vs threw) determines which
 * classification kind to pass; the taxonomy returns the waitMs floor
 * and shouldRetry flag used by the in-step retry's shared wait.
 */
export function classifyAdversarialOutcome(o: AdversarialOutcome) {
  return o.infra
    ? classifyFailureCause({ kind: "dispatch-failed-provider", providerMessage: o.errorTail })
    : classifyFailureCause({ kind: "dispatch-failed", errorTail: o.errorTail });
}

/**
 * The kinds that make up one adversarial pass's per-workstream event
 * batch (the events `fanOutAdversarial` appends in a single contiguous
 * run): the dispatch events, the per-round records, the per-workstream
 * outcome, `branch-completed` (N>1), `branches-converged` (N>1) and the
 * aggregate verdicts. `step-started` / `branches-fanned-out` / `cap-hit`
 * are NOT batch kinds — they mark the start of a pass or the park, and
 * the span never eats into them.
 */
const ADVERSARIAL_BATCH_KINDS: ReadonlySet<WorkEvent["kind"]> = new Set([
  "dispatch-completed",
  "dispatch-failed",
  "dispatch-failed-provider",
  "adversarial-round",
  "adversarial-workstream-outcome",
  "branch-completed",
  "branches-converged",
  "adversarial-approved",
  "adversarial-rejected",
]);

/**
 * #485/#486 — the [start, end) span of the previous adversarial pass's
 * per-workstream event batch in the log, or null when no such batch
 * exists.
 *
 * Anchor: the LAST `adversarial-workstream-outcome` in the log. Every
 * pass appends one per workstream in `ids` order, so the last outcome is
 * the last workstream's.
 *
 * The batch extends FORWARD from the anchor over the pass's own trailing
 * events (`branches-converged`, verdicts) — these sit AFTER the last
 * outcome, so the forward run is what makes the span cover the whole
 * prior pass's run (the per-workstream batch + the trailing events). The
 * forward run stops at a `cap-hit` (the prior pass's park cap — the
 * caller appends the new cap-hit after the splice, so the parked
 * outcome's log keeps the prior pass's records plus only the new
 * cap-hit) or any non-batch event.
 *
 * The batch extends BACKWARD from the anchor over the OTHER
 * workstreams' records (dispatch + round + outcome + branch events). The
 * backward run stops at:
 *  - a `cap-hit` (the prior pass's park cap — never eat into older
 *    records),
 *  - any other non-batch event (e.g. `step-started`).
 *
 * The span does NOT stop at an earlier `adversarial-workstream-outcome`:
 * a pass's per-workstream batch is contiguous in `ids` order (each
 * workstream's dispatch + round + outcome + branch events are interleaved
 * in `ids` order, with no non-batch events between workstreams), so the
 * contiguous run from the anchor backward covers the WHOLE prior pass's
 * per-workstream batch — including any surviving siblings' records that
 * sit in the same contiguous run. The caller's `survivorOutcomes`
 * (work-driver-adversarial-fanout.ts) re-emits the survivors' events in
 * `ids` order after the splice, so the log stays complete even though the
 * splice replaces the whole run (survivors' records + fresh-workstream
 * records) with the fresh batch (which includes the survivors' re-emitted
 * events).
 *
 * The caller computes the span on the ORIGINAL event log (before this
 * pass appends anything). On a first pass there is no prior batch (null);
 * on a re-entry the span covers the prior pass's per-workstream batch
 * (the trailing events included) and the splice replaces it with this
 * pass's fresh batch (which re-emits the survivors' events in `ids`
 * order).
 */
export function reentryPassBatchSpan(eventLog: readonly WorkEvent[]): [number, number] | null {
  // Find the last `adversarial-workstream-outcome` (the anchor).
  let anchor = -1;
  for (let i = eventLog.length - 1; i >= 0; i--) {
    if (eventLog[i]?.kind === "adversarial-workstream-outcome") {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) return null;
  // Extend FORWARD over the trailing events (branches-converged, verdicts).
  // The forward run stops at a `cap-hit` (the prior pass's park cap — the
  // caller appends the new cap-hit after the splice) or any non-batch
  // event.
  let end = anchor;
  for (;;) {
    const e = eventLog[end + 1];
    if (!e || e.kind === "cap-hit" || !ADVERSARIAL_BATCH_KINDS.has(e.kind)) break;
    end++;
  } // Extend BACKWARD over the other workstreams' records. The backward run
  // stops at a `cap-hit` (the prior pass's park cap — never eat into older
  // records) or any non-batch event. It does NOT stop at an earlier
  // `adversarial-workstream-outcome`: the per-workstream batch is
  // contiguous in `ids` order (no non-batch events between workstreams),
  // so the run covers the whole prior pass's per-workstream batch —
  // including any surviving siblings' records in the same run. The
  // caller's `survivorOutcomes` re-emits the survivors' events in `ids`
  // order after the splice, so the log stays complete.
  let start = anchor;
  while (start > 0) {
    const prev = eventLog[start - 1];
    if (!prev || prev.kind === "cap-hit" || !ADVERSARIAL_BATCH_KINDS.has(prev.kind)) {
      break;
    }
    start--;
  }
  return [start, end + 1];
}
