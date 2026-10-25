/**
 * adversarial-round-state — the loop's per-round review state, as ONE value.
 *
 * Each round of the adversarial loop re-reads the diff it is about to review and
 * re-points the head ref at whatever that re-read produced. Both must move
 * together: the truncation notice in the reviewer's prompt may only name the ref
 * range that actually produced the text under review (#1816), so a round whose
 * re-read FAILED keeps the previous diff and therefore has no range to name.
 *
 * Keeping the pair in one value updated in one place is what makes that rule
 * hard to break — a stale range cannot survive a failed re-read, because the
 * loop hands the whole round state to {@link roundAfterReread} rather than
 * poking at two variables and hoping it remembered both.
 *
 * Split from `adversarial.ts` (AGENTS.md §12, the 500-line gate).
 */

import { type DiffRange, rereadRangeForRound } from "./adversarial-diff-cap.ts";

/** The diff a round reviews, and the range its truncation notice may name. */
export interface RoundReview {
  /** The diff text the reviewer's prompt inlines. */
  diff: string;
  /** The ref range the caller actually diffed for THIS round, or nothing when
   * no range was run (a pasted diff) or the round's re-read failed. */
  range?: DiffRange;
}

/**
 * The state for a round whose diff re-read ran, or did not.
 *
 * `readRange` is whether this round actually obtained a range diff: `true` when
 * the loop ran `rangeDiffFn` for it, `false` when that call threw — the loop
 * keeps the previous diff then, so no range produced the text under review and
 * the notice must not name one (`undefined`). Callers pass `false` for a pasted
 * diff too, where no ref range was ever run.
 *
 * `headRef` is the head this round reviews (already resolved by the caller with
 * `roundHeadRef`, which keeps the loop's ledger identity in one place).
 */
export function roundAfterReread(
  prior: RoundReview,
  range: DiffRange | null,
  headRef: string | undefined,
  readRange: boolean,
  freshDiff: string | undefined,
): RoundReview {
  return {
    diff: readRange && freshDiff !== undefined && freshDiff.trim() ? freshDiff : prior.diff,
    range: rereadRangeForRound(range, headRef, readRange),
  };
}
