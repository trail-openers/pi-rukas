/**
 * lens-review-summary — the `LensReviewSummary` the NORMAL exit of a review
 * hands to `finishLensReview`, split out of lens-review.ts (AGENTS.md §12's
 * 500-line gate).
 *
 * One job: fold the round's four inputs — the verdict already computed, the
 * BLOCKING findings the verdict was computed from, the per-lens rows, and the
 * delta/forced-full provenance — into the summary shape, plus the memory fields
 * and the cap-kill fields each of their own module owns.
 *
 * The summary for a normal round. It reads no git, spawns nothing and decides
 * nothing: the verdict arrives decided, and `hasCritical` is derived at the call
 * site because the ledger write, not the summary, is what needs it.
 *
 * `findings`/`bySeverity`/`totalFindings` are all derived from the SAME array
 * the verdict read (`reported` — the blocking half, never the advisory tier),
 * which is #1143's invariant: an out-of-range finding neither decides the verdict
 * nor appears in the counts.
 */

import { capKillSummary } from "./lens-review-capkill.ts";
import type { AutoDeltaInfo, ForcedFullReason } from "./lens-review-delta-disclose.ts";
import { deltaReviewOf, forcedFullFieldOf } from "./lens-review-delta-disclose.ts";
import type { ReportedFindings } from "./lens-review-findings.ts";
import { memorySummaryFields } from "./lens-review-finish.ts";
import { type LensReviewSummary, type Verdict, bySeverityCounts } from "./lens-review-format.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import { aggregateLensUsage } from "./lens-review-usage.ts";

/**
 * The summary for a normal round.
 */
export function normalExitSummary(opts: {
  verdict: Verdict;
  reported: Finding[];
  lensResults: LensRunResult[];
  found: ReportedFindings;
  delta: AutoDeltaInfo | undefined;
  forcedFull?: ForcedFullReason;
}): LensReviewSummary {
  const { verdict, reported, lensResults, found, delta } = opts;
  return {
    verdict,
    totalFindings: reported.length,
    bySeverity: bySeverityCounts(reported),
    lenses: lensResults,
    findings: reported,
    ...memorySummaryFields(found),
    ...found.fields,
    usage: aggregateLensUsage(lensResults),
    // #543 — a dispatch-cap kill on any lens child (loop detector / token
    // budget) is surfaced on the summary so the driver emits the fixed-literal
    // cap-hit (F4g) instead of a silent 1-of-6 loss.
    ...capKillSummary(lensResults),
    ...(delta ? { deltaReview: deltaReviewOf(delta) } : {}),
    ...forcedFullFieldOf(opts.forcedFull),
  };
}
