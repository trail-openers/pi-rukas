/**
 * lens-review-diff-blocked — the review outcome when NOTHING was reviewed
 * (#966/#873/#384), split from lens-review-diff.ts (the 500-line gate; the diff
 * resolver that produces the block stays with the resolution rules).
 *
 * A diff the review cannot read is never a quiet approval. That single rule has
 * two exits here — the ROWS that name the lenses that never ran, and the SUMMARY
 * that scores them — and they must agree exactly, because `computeVerdict` reads
 * the rows while the ledger and the operator read the summary. An empty roster
 * yielding zero rows is the shape that made an empty review APPROVED, so both
 * builders below guarantee at least one NAMED row; neither is free to return an
 * empty list.
 */

import * as dispatchDeck from "./dispatch-deck.ts";
import { bySeverityCounts, computeVerdict, dedupeFindings } from "./lens-review-format.ts";
import type { LensRunResult, Severity } from "./lens-review.ts";
import type { Finding } from "./lens-review.ts";
import type { RosterEntry } from "./lens-roster.ts";

/**
 * Build the blocked rows for an unresolvable diff from the EXPECTED roster
 * (one blocked row per lens the review would have run). Feeds the
 * REVIEW_INCOMPLETE verdict — the review is incomplete, not approved.
 */
export function blockedRowsForRoster(roster: RosterEntry[], problem: string): LensRunResult[] {
  // #966 — an empty roster must NEVER yield zero blocked rows: `computeVerdict`
  // over zero rows returns APPROVED (the silent-approval this guard closes).
  // A review whose expected set is unknown (roster unavailable) or empty still
  // produces one named blocked row so the verdict is REVIEW_INCOMPLETE.
  if (roster.length === 0) {
    return [
      {
        lens: "LENSES",
        ok: false,
        ms: 0,
        startMs: Date.now(),
        findings: [],
        attempts: 0,
        blocked: true,
        parseError: problem,
      },
    ];
  }
  return roster.map((e) => ({
    lens: e.name,
    ok: false,
    ms: 0,
    startMs: Date.now(),
    findings: [],
    attempts: 0,
    blocked: true,
    parseError: problem,
  }));
}

/**
 * The single blocked-review summary for an unresolvable diff: dedup the
 * extra findings against the expected roster, score the verdict with the
 * resolved threshold, and bump the deck's batch row once per blocked lens so
 * the pass shows as finished (no spawn happened — the lens "completed" as a
 * block). Keeping the shape here (rather than in runLensReview) is what keeps
 * lens-review.ts under the 500-line gate.
 */
export function blockedReviewSummary(
  runId: string,
  extraFindings: Finding[] | undefined,
  roster: RosterEntry[],
  blockRows: LensRunResult[],
  threshold: Severity,
): {
  verdict: ReturnType<typeof computeVerdict>;
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  lenses: LensRunResult[];
  findings: Finding[];
  usage: undefined;
} {
  const batchKey = `${runId}/batch`;
  dispatchDeck.startBatchEntry(batchKey, {
    label: `code-review-specialist×${blockRows.length}`,
    size: blockRows.length,
  });
  for (let i = 1; i <= blockRows.length; i++) {
    dispatchDeck.updateBatchProgress(batchKey, i);
  }
  dispatchDeck.clearBatchEntry(batchKey);
  const all = [...(extraFindings ?? [])];
  const deduped = dedupeFindings(all, roster);
  return {
    verdict: computeVerdict(deduped, blockRows, threshold),
    totalFindings: deduped.length,
    bySeverity: bySeverityCounts(deduped),
    lenses: blockRows,
    findings: deduped,
    usage: undefined,
  };
}
