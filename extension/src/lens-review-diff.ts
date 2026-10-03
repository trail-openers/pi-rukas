/**
 * lens-review-diff — the #859 ref-range diff resolution for the lens review,
 * split from lens-review.ts (the 500-line gate headroom).
 *
 * When `dispatch_lens_review` is called with `base` + `head` (no pasted
 * `diff` string), the diff is computed ONCE via `computeRangeDiff`
 * (review-diff.ts — execFile, no shell; the same positive-empty rule as
 * #384) and that single value is threaded to every lens child. An error
 * (invalid ref naming the ref, confirmed-empty range, cap overflow, nothing
 * supplied) blocks the whole review as a failed result — a computed diff is
 * never silently empty and never read as "nothing to review" (an approval).
 *
 * Blocked rows use the EXPECTED (installed + bundled) roster the caller
 * already built — a diff error is a review-level failure, so the blocked
 * rows name the lenses the review would have run. `installBlockRows`
 * (bundled-only) is reserved for the skills-dir problem case.
 */

import * as dispatchDeck from "./dispatch-deck.ts";
import { bySeverityCounts, computeVerdict, dedupeFindings } from "./lens-review-format.ts";
import type { LensRunResult, Severity, Verdict } from "./lens-review.ts";
import type { Finding } from "./lens-review.ts";
import type { RosterEntry } from "./lens-roster.ts";
import { computeRangeDiff } from "./review-diff.ts";

/**
 * Resolve the review's diff from either a pasted string or a ref range.
 *
 * - `diff` present → wins (even when base+head are also present; the
 *   "diff string wins" rule, traced by the caller).
 * - no `diff`, base+head present → `computeRangeDiff(cwd ?? process.cwd(),
 *   base, head)`; an error becomes a problem (never an empty-string
 *   approval).
 * - neither → a problem (a caller error, not an approval).
 */
export async function resolveLensDiff(opts: {
  diff?: string;
  base?: string;
  head?: string;
  cwd?: string;
}): Promise<{ diff?: string; problem?: string }> {
  if (opts.diff) return { diff: opts.diff };
  if (opts.base && opts.head) {
    const range = await computeRangeDiff(opts.cwd ?? process.cwd(), opts.base, opts.head);
    if (!range.ok) {
      return {
        problem: `lens review: cannot compute diff for ${opts.base}...${opts.head}: ${range.reason}`,
      };
    }
    return { diff: range.diff };
  }
  return {
    problem: "lens review: no diff supplied (pass `diff`, or both `base` and `head`)",
  };
}

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

/**
 * The persistent batch summary row (#139): the "X/6 done" deck entry that
 * lets the user watch the pass throughout the run even as fast lenses drop
 * out at 0s linger. Registered BEFORE the per-lens entries so its seq sorts
 * first on Pi's footer (moved here from runLensReview for the 500-line cap).
 */
export function startPersistentBatch(
  runId: string,
  size: number,
): { batchKey: string; bumpBatch: () => void } {
  const batchKey = `${runId}/batch`;
  dispatchDeck.startBatchEntry(batchKey, {
    label: `code-review-specialist×${size}`,
    size,
  });
  let completedLenses = 0;
  return {
    batchKey,
    bumpBatch: () => {
      completedLenses += 1;
      dispatchDeck.updateBatchProgress(batchKey, completedLenses);
    },
  };
}
