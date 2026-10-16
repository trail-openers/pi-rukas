/**
 * lens-review-findings — what a completed fan-out REPORTS (#1140/#1125), split
 * from lens-review.ts (the 500-line gate).
 *
 * Three things happen between "the lenses answered" and "the verdict is
 * computed", and they belong together because each one moves a finding out of
 * the list the verdict reads:
 *
 *   1. the round is recorded against the findings memory (#1105): accepted rows
 *      suppress findings, a complete full review resolves rows it no longer
 *      reports, and open rows whose code is unchanged are CARRIED — a lens
 *      omitting a known finding is not a fix;
 *   2. the carried rows join this round's fresh ones, and `splitAdvisory`
 *      (#1140 file level, #1125 line level) moves every finding whose cited line
 *      is outside the PR's changed lines into the advisory tier;
 *   3. the BLOCKING half is what the review hands to the verdict, the severity
 *      counts, the summary and the ledger's `hasCritical` — so an out-of-range
 *      CRITICAL, fresh or carried, neither decides the verdict nor holds the
 *      round budget nor blocks the merge (#1143's invariant, at line level).
 *
 * Fail-open on memory: an unrecorded round reports every finding and says why,
 * because a memory problem must not quietly change what a review blocks on.
 * Fail-CLOSED on the range: when the changed lines cannot be read every finding
 * blocks and the note names the reason (lens-review-advisory.ts).
 */

import { partitionDecisions } from "./lens-residuals.ts";
import type { SuppressedFinding } from "./lens-residuals.ts";
import { splitAdvisory } from "./lens-review-advisory.ts";
import type { AutoDeltaInfo } from "./lens-review-diff.ts";
import { isReviewIncomplete } from "./lens-review-incomplete.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import type { ResolvedNotice } from "./review-findings-file.ts";
import { recordFindingRunOutcome } from "./review-findings-store.ts";

/** The kind of review the findings memory records this round as (#1105): a
 * delta covers only its range, an incomplete one re-reported nothing reliably,
 * and only a `full` review may resolve rows it did not re-report. */
export function reviewKind(
  delta: unknown,
  lensResults: readonly LensRunResult[],
): "delta" | "incomplete" | "full" {
  if (delta) return "delta";
  return isReviewIncomplete(lensResults) ? "incomplete" : "full";
}

export interface ReportedFindings {
  /** The findings the verdict, the counts, the summary and `hasCritical` read. */
  reported: Finding[];
  /** Suppressed by an operator's accept decision (summary field). */
  suppressed: SuppressedFinding[];
  /** Rows the memory resolved because a complete review no longer reports them. */
  resolved: ResolvedNotice[];
  /** Summary fields from the memory and the advisory split. Either note may be
   * set, and when BOTH are the round says both: `memoryNote` means the round was
   * not recorded at all, the advisory note means the changed lines could not be
   * read. They are composed, never one dropped for the other. */
  fields: { advisory?: Finding[]; memoryNote?: string };
}

/**
 * Record the round, apply the operator's decisions, carry the standing rows and
 * split them into blocking and advisory. `deduped` is every finding the round
 * produced (lens findings plus deterministic ones), already deduped.
 *
 * `branchResolved`/`headSha` gate the memory write: without a branch or a head
 * there is nothing to key the round on, so no rows carry and nothing resolves —
 * every finding still blocks, which is the pre-memory behaviour.
 */
export async function resolveReportedFindings(opts: {
  deduped: Finding[];
  lensResults: readonly LensRunResult[];
  delta: AutoDeltaInfo | undefined;
  cwd: string | undefined;
  base: string | undefined;
  branchResolved: string | undefined;
  headSha: string | undefined;
  diff: string;
}): Promise<ReportedFindings> {
  const { deduped, lensResults, delta, branchResolved, headSha } = opts;
  const review = reviewKind(delta, lensResults);
  const recorded =
    branchResolved && headSha
      ? await recordFindingRunOutcome({
          cwd: opts.cwd ?? process.cwd(),
          branch: branchResolved,
          headSha,
          findings: deduped,
          ...(delta ? { deltaDiff: opts.diff } : {}),
          review,
        })
      : undefined;
  // Fail open: an unrecorded round reports every finding, and the summary and
  // the residual comment say why memory was not used.
  const memoryNote =
    recorded && !recorded.ok ? `findings memory unavailable: ${recorded.reason}` : undefined;
  const decisions = recorded?.ok ? recorded.decisions : undefined;
  const { kept, suppressed } = partitionDecisions(deduped, decisions);
  // #1105 — open rows this round did not re-report, whose cited code is
  // unchanged, still stand. They join this round's findings, and #1140/#1125
  // makes any of them advisory unless its cited line is in the PR's changed
  // lines. The discount is earned only by a range actually READ (headSha
  // resolved); with none, nothing is discounted — #1143's invariant is "out of
  // range", never "range unknown". The changed lines come from the diff THIS
  // review ran (`opts.diff` — the value the lenses were handed, so the split and
  // the review cannot disagree); the git range read is the fallback for a round
  // with no diff string, and a delta round's range is the delta's own.
  const advisory = await splitAdvisory({
    reported: [...kept, ...(recorded?.ok ? (recorded.carried ?? []) : [])],
    cwd: opts.cwd,
    base: opts.base,
    head: headSha,
    // A delta round's diff is only `since..head`, so the split ignores it as a
    // source and reads the PR's whole `base...head` (blocking is never
    // delta-scoped; #1125 decision 5 scopes resolution, which the store does).
    ...(opts.diff ? { diff: opts.diff } : {}),
    isDelta: delta !== undefined,
  });
  const fields: ReportedFindings["fields"] = {};
  if (advisory.fields.advisory) fields.advisory = advisory.fields.advisory;
  // Both notes, when both fired: the memory note says the round was not
  // recorded, the advisory note says the discount could not be earned. Neither
  // is a substitute for the other, so `??` dropping one would hide a failure.
  const note = [memoryNote, advisory.fields.memoryNote].filter(Boolean).join("; ");
  if (note) fields.memoryNote = note;
  return {
    reported: advisory.blocking,
    suppressed,
    resolved: recorded?.ok ? recorded.resolved : [],
    fields,
  };
}
