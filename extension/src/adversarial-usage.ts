/**
 * adversarial-usage — the loop's accumulated cost and the result it builds.
 *
 * `runAdversarialLoop` folds every dispatch result it receives into one
 * usage/cost tally and remembers the last transcript and model it saw, so the
 * result it finally synthesises reports what the WHOLE loop spent rather than
 * what its last round did. Three shapes return early (a rejected verdict
 * policy, a diff that could not be computed, workCwd missing) and each folds
 * through the same tally, so a partial loop's cost is never reported as zero.
 *
 * Split from `adversarial.ts` (AGENTS.md §12, the 500-line gate).
 */

import type { DispatchResult, DispatchUsage } from "./types.ts";

/** What a result carries when nothing ran at all. Module-local: the loop reads
 * the tally's `usage`, and nothing outside this file needs a zeroed shape. */
function emptyUsage(): DispatchUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/** The loop's running tally, read at CALL time by the result builders. */
export interface UsageTally {
  usage: DispatchUsage;
  lastTranscript: string | undefined;
  lastModel: string | undefined;
  /** Fold one dispatch result in: its cost, its transcript, and the first model. */
  accumulate: (r: DispatchResult) => void;
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
      if (r.usage) {
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        usage.cacheRead += r.usage.cacheRead;
        usage.cacheWrite += r.usage.cacheWrite;
        usage.cost += r.usage.cost;
        usage.turns += r.usage.turns;
      }
      if (r.transcriptPath) lastTranscript = r.transcriptPath;
      if (r.model && !lastModel) lastModel = r.model;
    },
  };
}
