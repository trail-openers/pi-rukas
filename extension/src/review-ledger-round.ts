/**
 * review-ledger-round — the #973 branch-scoped round counter, split from
 * review-ledger.ts (AGENTS.md §12 file-size limit).
 *
 * `appendLedgerEntry` (review-ledger.ts) calls this on every write; the
 * round is a pure function of the ledger file's previous contents, so it
 * lives in its own module to keep the ledger writer under the size limit.
 * The re-export in review-ledger.ts keeps importers unchanged.
 */

import type { LedgerEntry } from "./review-ledger.ts";

/**
 * #973 — advance the round counter for a lens write: a COMPLETED review
 * (verdict ISSUES_FOUND, APPROVED or CRITICAL_ISSUES_FOUND) runs as the
 * previous latest lens entry's `round` + 1 (legacy entries without `round`
 * count as 1; no previous lens entry is a first run, which is round 1). An
 * INCOMPLETE review (an explicit REVIEW_INCOMPLETE verdict — killed or
 * aborted runs; a legacy row without `detail` still counts as completed,
 * as before) does NOT advance the counter — it carries the previous round
 * unchanged (or is a first run, round 1, when there is no previous entry).
 * Otherwise a killed run wedged between two completed runs would consume a
 * round the driver never spent, and the guard's `round >= 3` cap condition
 * would fire one run early. Adversarial writes and rows for other branches
 * pass through unchanged.
 *
 * #1127 — `incompleteRuns` counts the consecutive INCOMPLETE runs since the last
 * completed one (reset to 0 by a completed run). The round stays put for those
 * runs, so without this counter a lens that keeps failing could be re-run
 * forever at the same round; the tool-side budget refuses once the streak
 * reaches the cap. The input rows are the deduped contents of the
 * ledger file as re-read immediately before this write, so the number is
 * deterministic in the file's state.
 */
export function bumpLensRound(entry: LedgerEntry, existing: LedgerEntry[]): LedgerEntry {
  if (entry.kind !== "lens") return entry;
  let prev: LedgerEntry | undefined;
  for (const e of existing) {
    if (e.branch !== entry.branch || e.kind !== "lens") continue;
    if (!prev || e.at >= prev.at) prev = e;
  }
  const completed = entry.detail !== "REVIEW_INCOMPLETE";
  const incompleteRuns = completed ? 0 : (prev?.incompleteRuns ?? 0) + 1;
  // #1129 — the round is PROBED before the review and stored as given;
  // the write-time derivation below is only the fallback for a caller that
  // did not probe (the same function, so the two cannot disagree).
  return { ...entry, round: entry.round ?? roundAfter(prev), incompleteRuns };
}

/**
 * #1129 — the round a lens run is recorded as, given the branch's latest
 * lens entry (`undefined` when there is none): no prior entry → 1; a prior
 * entry without `round` (legacy) → 2; a prior REVIEW_INCOMPLETE run → its
 * round (an incomplete run does not advance the round); otherwise → its
 * round + 1.
 */
export function roundAfter(prev: LedgerEntry | undefined): number {
  if (!prev) return 1;
  if (prev.round === undefined) return 2;
  return prev.detail === "REVIEW_INCOMPLETE" ? prev.round : prev.round + 1;
}
