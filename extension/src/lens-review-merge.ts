/**
 * lens-review-merge — the merge exit of the six-pass review, split out of
 * lens-review.ts (AGENTS.md §12's 500-line gate).
 *
 * Two things happen here and nothing else: the fan-in's findings (the lenses'
 * own plus the deterministic claim-scan rows) are deduped by
 * (path, line, title) with lens precedence, and the ONE severity-cap pass runs
 * over the result. Both belong together because the cap runs AFTER dedup — the
 * row that survives a collision is the row whose severity the whole round is
 * judged by, so capping before the merge would cap a row that then gets thrown
 * away and leave the surviving row uncapped.
 *
 * This is the single point every lens finding passes through on the normal
 * review path. The blocked/aborted path has its own merge (blockedReviewSummary
 * in lens-review-diff-blocked.ts) and applies the same pass there, so no review
 * shape escapes it.
 *
 * `recordedToolUses` is the evidence the second cap reads: what the lens children
 * that produced these findings are recorded as having RUN (#2040). It is a
 * parameter rather than something this module reads because the calls belong to
 * the children, which live in the caller — and passing them per child is what
 * makes a HIGH that cites a command another lens ran impossible to keep.
 */

import { dedupeFindings } from "./lens-review-format.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import type { RosterEntry } from "./lens-roster.ts";
import { capFindings } from "./lens-severity-rubric.ts";
import { evidenceByLens } from "./lens-unproven-high.ts";
import type { ReproductionEvidence } from "./lens-unproven-high.ts";

/** Dedup, then cap (test-path first, then unproven). Order matters — see the module jsdoc. */
export function mergeLensFindings(
  findings: Finding[],
  roster: RosterEntry[],
  evidence: ReproductionEvidence = [],
): Finding[] {
  return capFindings(dedupeFindings(findings, roster), evidence);
}

/**
 * The merge exit for a normal round: build the round's per-child evidence from
 * its lens children, then dedup and cap the fan-in's findings against it.
 *
 * One call rather than two because the two are one fact: the evidence the cap
 * applies and the evidence the round later reports are the SAME surface, and a
 * caller that built them separately could cap a row against one view of the
 * children and record the round against another. The evidence goes back to the
 * caller because the findings round threads it to the store, where the rows this
 * round CARRIES are judged by the same children (#2040).
 */
export function lensMerge(
  findings: Finding[],
  roster: RosterEntry[],
  lensResults: LensRunResult[],
): { deduped: Finding[]; evidence: ReproductionEvidence } {
  const evidence = evidenceByLens(lensResults);
  return { deduped: mergeLensFindings(findings, roster, evidence), evidence };
}
