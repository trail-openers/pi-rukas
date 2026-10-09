/**
 * review-ledger-merge — the #1069 race-fallback merge step, extracted as a
 * pure helper (no fs) so it is unit-testable without mocking node:fs.
 *
 * The happy path in `appendLedgerEntry` (review-ledger.ts) writes a temp
 * file and renames it into the ledger path. When a concurrent writer wins
 * the rename, ours throws, and the fallback re-reads the file (winner's
 * rows, possibly including a stale row of ours that lost an earlier race),
 * merges the new entry in, and rewrites. This file is the merge step of
 * that fallback — the one operation #1069 broke and the fix corrects:
 *
 *   push the bumped entry FIRST, then dedupe.
 *
 * The pre-#1069 order (dedupe → push) is not a no-op when the re-read file
 * already holds a row for our (branch, kind): both rows survive — the
 * duplicate pair #1069 observed. Dedupe after push is idempotent.
 *
 * The happy path keeps its own inline push (the input was just deduped,
 * so a bare push is safe there); only the fallback needed the correction,
 * and only the fallback was broken. Extracting the merge step into its own
 * module (no fs, no git, no time) makes the ordering unit-testable without
 * mocking node:fs, and trims review-ledger.ts's line count (AGENTS.md §12).
 */

import { dedupeLatest } from "./review-ledger-core.ts";
import { bumpLensRound } from "./review-ledger-round.ts";
import type { LedgerEntry } from "./review-ledger.ts";

/**
 * Merge a re-read ledger file's contents with a new entry (the
 * race-fallback's single operation, #1069):
 *
 *   1. bump the new entry's round off the existing rows (the #973
 *      round counter is a pure function of the file's previous contents),
 *   2. append it,
 *   3. dedupe per (branch, kind) (the guard reads only the latest per
 *      pair, so older rows would be dead weight — and two rows for the
 *      same pair is the #1069 bug).
 *
 * Pure: no fs, no git, no time. The input `existing` rows may be a
 * mix of adversarial and lens entries for multiple branches; the output
 * preserves that mix, with exactly one row per (branch, kind).
 */
export function mergeAfterRace(existing: LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  const bumped = bumpLensRound(entry, existing);
  return dedupeLatest([...existing, bumped]);
}
