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
 */

import { dedupeFindings } from "./lens-review-format.ts";
import type { Finding } from "./lens-review-types.ts";
import type { RosterEntry } from "./lens-roster.ts";
import { capTestPathFindings } from "./lens-severity-rubric.ts";

/** Dedup, then cap. Order matters — see the module jsdoc. */
export function mergeLensFindings(findings: Finding[], roster: RosterEntry[]): Finding[] {
  return capTestPathFindings(dedupeFindings(findings, roster));
}
