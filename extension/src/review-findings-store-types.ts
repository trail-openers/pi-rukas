/**
 * review-findings-store-types — the leaf the findings store and the round share.
 *
 * `ConfirmationLapse` is produced by `applyFindingRound` (review-findings-round.ts)
 * and returned by `recordFindingRunOutcome` (review-findings-store.ts). Declared
 * in a module that imports neither of them for the same reason `Decision` and
 * `ResolvedNotice` are declared in review-findings-file.ts: a copy in either one
 * makes the two modules import each other, and the store's per-round outcome type
 * is the only place a caller reads this from.
 */

/**
 * #1934 AC4 — one row whose independent confirmation went stale: a row a
 * previous round retired on a confirmation that this round found no longer binds
 * to the commit under review. The row stays `open` and its cited code is
 * unchanged — what changed is the evidence — and the row carries
 * `confirmationLapsed` so a later reader can see it was once retired and is not
 * now. `provenance` is the confirmation it WAS retired on (the string the row
 * carried while it stood), which is what makes the disclosure a statement about
 * a real review rather than "something changed".
 */
export interface ConfirmationLapse {
  rowId: string;
  title: string;
  provenance: string;
}
