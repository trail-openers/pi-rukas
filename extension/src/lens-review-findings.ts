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
import type { AutoDeltaInfo } from "./lens-review-delta-disclose.ts";
import { isReviewIncomplete } from "./lens-review-incomplete.ts";
import { type MemoryDisclosure, memoryDisclosure, recordRound } from "./lens-review-memory.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import type { ReviewKind } from "./review-findings-fate.ts";
import type { ResolvedNotice, SetAsideNotice } from "./review-findings-file.ts";

/** The kind of review the findings memory records this round as (#1105): a
 * delta covers only its range, an incomplete one re-reported nothing reliably,
 * and only a `full` review may resolve rows it did not re-report. File-local:
 * the one caller is below, and a named export invited a second definition. */
function reviewKind(
  delta: AutoDeltaInfo | undefined,
  lensResults: readonly LensRunResult[],
): ReviewKind {
  if (delta) return "delta";
  return isReviewIncomplete(lensResults) ? "incomplete" : "full";
}

export interface ReportedFindings {
  /** The findings the verdict, the counts, the summary and `hasCritical` read. */
  reported: Finding[];
  /** Suppressed by an operator's accept decision (summary field). */
  suppressed: SuppressedFinding[];
  /** Rows the memory resolved because a complete review no longer reports them,
   * or evicted because their cited code is gone (#1125/#1408). */
  resolved: ResolvedNotice[];
  /** Rows the store set aside: a malformed row, or an acceptance that lapsed
   * because its cited code changed (#1125). A suppression that vanished is
   * disclosed, never left to return as a "new" finding. */
  setAside?: SetAsideNotice[];
  /** Summary fields from the memory and the advisory split. Either note may be
   * set, and when BOTH are the round says both: `memoryNote` means the round was
   * not recorded at all (in words distinct from "the store was empty"), the
   * advisory note means the changed lines could not be read. They are composed,
   * never one dropped for the other. */
  fields: { advisory?: Finding[]; memoryNote?: string };
}

/**
 * Record the round (through `recordRound`, the memory seam), apply the
 * operator's decisions, carry the standing rows and split them into blocking and
 * advisory. `deduped` is every finding the round produced (lens findings plus
 * deterministic ones), already deduped.
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
  /** The diff the review RESOLVED (`resolveReviewDiff`'s ok outcome): who
   * produced the text above, and which range it covers. A `"caller"` diff is a
   * pasted string the review never read from git; a `"computed"` one was read
   * from refs, and `resolved.base` names the base it was read against (`head`
   * is that ref as the caller named it, which is not necessarily `headSha`).
   * The split trusts the TEXT only for a full review — a computed diff over the
   * very range the split would otherwise read, i.e. the one whose base is known.
   * A pasted string, and a delta's `since..head` (whose base is the delta's,
   * never the PR's), are both judged against the git `base...head` read. */
  resolved: { diffSource: "caller" | "computed"; base?: string; head?: string };
}): Promise<ReportedFindings> {
  const { deduped, lensResults, delta, branchResolved, headSha } = opts;
  const review = reviewKind(delta, lensResults);
  // The round is recorded through the memory seam (#1408): the same module that
  // shows the lenses their prior findings writes the round, so the evidence the
  // round acted on and the rows it recorded against cannot come from different
  // reads of the store. `undefined` when there is no branch/head to key on.
  const recorded = await recordRound({
    cwd: opts.cwd ?? process.cwd(),
    branch: branchResolved,
    headSha,
    findings: deduped,
    review,
    ...(delta ? { deltaDiff: opts.diff } : {}),
  });
  // Fail open, and fail OPEN *visibly*: `memoryDisclosure` keeps "the round could
  // not be recorded, because …" distinct from "the store was empty", and carries
  // any set-aside the round earned before the write refused (#1125).
  const memory: MemoryDisclosure = memoryDisclosure(recorded);
  const decisions = recorded?.ok ? recorded.decisions : undefined;
  const { kept, suppressed } = partitionDecisions(deduped, decisions);
  // #1105 — open rows this round did not re-report, whose cited code is
  // unchanged, still stand. They join this round's findings, and #1140/#1125
  // makes any of them advisory unless its cited line is in the PR's changed
  // lines. The discount is earned only by a range actually READ (headSha
  // resolved); with none, nothing is discounted — #1143's invariant is "out of
  // range", never "range unknown". The changed lines come from the diff THIS
  // review computed from refs (`opts.diff` when `diffSource` says so — the value
  // the lenses were handed, so the split and the review cannot disagree); a
  // caller-pasted string and a delta's own range are both judged against the
  // PR's whole `base...head`, which the split reads itself.
  const advisory = await splitAdvisory({
    reported: [...kept, ...(recorded?.ok ? (recorded.carried ?? []) : [])],
    cwd: opts.cwd,
    base: opts.base,
    head: headSha,
    // The reviewed range is the one the split would itself read: a computed diff
    // whose base is the range's base (`diffBaseOf` hands that up, and a delta's
    // is its `since`, so a delta never matches) and whose head is the head now
    // resolved to a SHA. A pasted string is not evidence of what the PR changed
    // — it omits and contradicts — so it is judged against the `base...head`
    // read like any other shape.
    ...(opts.resolved.diffSource === "computed" &&
    // No base named means no range to match the diff against, so the split's own
    // `base...head` read is the source whatever the diff claims to be.
    opts.base !== undefined &&
    opts.resolved.base === opts.base &&
    opts.resolved.base !== undefined &&
    opts.resolved.head === (headSha ?? opts.resolved.head)
      ? { diff: opts.diff, diffComputed: true }
      : {}),
  });
  const fields: ReportedFindings["fields"] = {};
  if (advisory.fields.advisory) fields.advisory = advisory.fields.advisory;
  // Both notes, when both fired: the memory note says the round was not
  // recorded, the advisory note says the discount could not be earned. Neither
  // is a substitute for the other, so `??` dropping one would hide a failure.
  const note = [memory.memoryNote, advisory.fields.memoryNote].filter(Boolean).join("; ");
  if (note) fields.memoryNote = note;
  return {
    reported: advisory.blocking,
    suppressed,
    resolved: recorded?.ok ? recorded.resolved : [],
    ...(memory.setAside ? { setAside: memory.setAside } : {}),
    fields,
  };
}
