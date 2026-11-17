/**
 * adversarial-usage — the loop's accumulated cost and the round bookkeeping it
 * reports with.
 *
 * `runAdversarialLoop` folds every dispatch result it receives into one
 * usage/cost tally and remembers the last transcript and model it saw, so the
 * result it finally synthesises reports what the WHOLE loop spent rather than
 * what its last round did. Three shapes return early (a rejected verdict
 * policy, a diff that could not be computed, workCwd missing) and each folds
 * through the same tally, so a partial loop's cost is never reported as zero.
 *
 * This file also holds the loop's per-round record: one entry per dispatched
 * round, which the result builders fold into `adversarialRounds`.
 *
 * Split from `adversarial.ts` (AGENTS.md §12, the 500-line gate).
 */

import type { AdversarialVerdict, DispatchResult, DispatchUsage } from "./types.ts";
import { addCount } from "./usage-fold.ts";

/** What a result carries when nothing ran at all. Module-local: the loop reads
 * the tally's `usage`, and nothing outside this file needs a zeroed shape. */
function emptyUsage(): DispatchUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
  };
}

/** The loop's running tally, read at CALL time by the result builders. */
export interface UsageTally {
  usage: DispatchUsage;
  lastTranscript: string | undefined;
  lastModel: string | undefined;
  /** Fold one dispatch result in: its cost, its transcript, and the first model. */
  accumulate: (r: DispatchResult) => void;
  /**
   * Fold a child's COST in and nothing else. The re-ask is a child the round
   * paid for, so its tokens belong in the totals; its transcript and model do
   * not, because the round is the ORIGINAL reviewer's round and its result must
   * keep naming the reviewer's session and model.
   */
  accumulateUsageOnly: (r: DispatchResult) => void;
}

export function createUsageTally(): UsageTally {
  const usage = emptyUsage();
  let lastTranscript: string | undefined;
  let lastModel: string | undefined;
  return {
    usage,
    get lastTranscript() {
      return lastTranscript;
    },
    get lastModel() {
      return lastModel;
    },
    accumulate: (r: DispatchResult) => {
      accumulateUsage(r);
      if (r.transcriptPath) lastTranscript = r.transcriptPath;
      if (r.model && !lastModel) lastModel = r.model;
    },
    accumulateUsageOnly: accumulateUsage,
  };

  /** The cost half of {@link accumulate}, alone. */
  function accumulateUsage(r: DispatchResult): void {
    if (!r.usage) return;
    usage.input += r.usage.input;
    usage.output += r.usage.output;
    usage.cacheRead += r.usage.cacheRead;
    usage.cacheWrite += r.usage.cacheWrite;
    usage.cost += r.usage.cost;
    usage.turns += r.usage.turns;
    usage.toolCalls = addCount(usage.toolCalls, r.usage.toolCalls);
    usage.toolErrors = addCount(usage.toolErrors, r.usage.toolErrors);
  }
}

/** One round's outcome, as the loop records it for the ledger and the report. */
export interface RoundRecord {
  round: number;
  verdict: AdversarialVerdict;
  ms: number;
  /** The verdict came from the re-ask rather than from the reviewer's own reply.
   * Absent for every round the reviewer signed, so the record a reader of the
   * pre-re-ask loop saw is unchanged. */
  verdictFromReask?: boolean;
}
