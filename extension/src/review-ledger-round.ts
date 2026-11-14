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
 * #2223 — the head an INCOMPLETE lens row carries.
 *
 * The round counter above never touches `headSha`, so an incomplete run wrote the
 * head it was invoked at. `resolveDeltaSince` reads exactly that field as "where
 * this branch was last reviewed", and `reviewedHeadFromEntries` reads it as the
 * merged-head proof — so one round in which no lens started made its head look
 * reviewed, and the next dispatch at that head answered "no changes since the
 * last lens review" with no verdict at all. A run that never read a diff cannot
 * testify about the commit it was pointed at.
 *
 * The row therefore carries the previous COMPLETED run's head — `undefined` when
 * the branch has never completed one, which is the ledger's existing "unknown
 * head" shape (a legacy row with no `headSha`), so every reader already has a
 * correct rule for it.
 *
 * `undefined` rather than `entry.headSha` is the whole of it, and the reason is the
 * field's contract: `LedgerEntry.headSha` means "the commit this row's verdict was
 * reached AT", and `runLensReview` resolves it (#1039) BEFORE the fan-out, so an
 * incomplete row is handed a real SHA for a head whose diff no lens ever read.
 * Copying it is the lie. The shape is not redundant with the reader's own check
 * (`resolveDeltaSince` refuses an incomplete row as a base): this is the row the
 * MERGED-HEAD proof reads, the round-cap comparison reads, and the next round reads
 * after the ledger is re-read by another process — none of which calls the delta
 * reader. Keeping the head on the row would put the correctness of "a head nobody
 * reviewed is not reviewed" in one caller's hands rather than in the data.
 *
 * The walk goes back to the last COMPLETED row rather than asking only the
 * immediate predecessor, and consecutive incomplete runs are why. The first
 * incomplete round carries the completed head forward; if the next round asked its
 * predecessor alone it would find an incomplete row, answer "no head", and the
 * streak would have erased the proof that anything was ever reviewed — a branch
 * that fails two rounds in a row would be indistinguishable from one that never
 * completed a review. Same rule as the round counter above, which likewise reads
 * the previous round through an incomplete row rather than resetting it.
 */
function incompleteHeadSha(existing: LedgerEntry[], branch: string): string | undefined {
  // Scan the key's rows from the oldest forward and keep the newest one that
  // actually completed a review, so a streak of failed rounds cannot erase the
  // proof of the last review that happened (see the jsdoc).
  let head: string | undefined;
  for (const e of existing) {
    if (e.branch !== branch || e.kind !== "lens") continue;
    // #1176 — a carry is a copy of a verdict onto a head whose diff nobody read,
    // so it testifies about `carriedFrom`, never about its own `headSha`. The
    // counter above applies the same marker rule to the row it is handed; a scan
    // that asked only verdict and head-presence would credit an unreviewed head.
    if (e.carriedFrom !== undefined) continue;
    if (e.detail === "REVIEW_INCOMPLETE" || !e.headSha) continue;
    head = e.headSha;
  }
  return head;
}

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
 *
 * #1176 — the carry marker. A carried entry (lens-review-auto-delta.ts
 * writeCarriedEntry) is a copy of a recorded verdict onto a new head, not a
 * review, so it must not advance the counter. It is recognised by
 * `carriedFrom` — and ONLY by that field: the round it copies is already on
 * the entry, so the counter is skipped and the entry is returned as written.
 * Nothing else bypasses the advance. A normal lens append that happens to
 * arrive with a `round` set (no `carriedFrom`) still advances from the
 * previous latest entry, so a stale or caller-supplied round can never freeze
 * the counter. Adversarial writes never reach the lens path below.
 */
export function bumpLensRound(entry: LedgerEntry, existing: LedgerEntry[]): LedgerEntry {
  if (entry.kind !== "lens") return entry;
  // #1176 — the explicit carry marker (see the jsdoc): a carry adds no review round.
  if (entry.carriedFrom !== undefined) return entry;
  let prev: LedgerEntry | undefined;
  for (const e of existing) {
    if (e.branch !== entry.branch || e.kind !== "lens") continue;
    if (!prev || e.at >= prev.at) prev = e;
  }
  const completed = entry.detail !== "REVIEW_INCOMPLETE";
  const next = completed ? (prev ? (prev.round ?? 1) : 0) + 1 : (prev?.round ?? 1);
  const incompleteRuns = completed ? 0 : (prev?.incompleteRuns ?? 0) + 1;
  return {
    ...bumpCarryHead(entry, completed, existing),
    round: next,
    incompleteRuns,
  };
}

/**
 * Apply #2223's head rule to a lens write: an INCOMPLETE row stops claiming the
 * head it was invoked at, and a COMPLETED row is left exactly as written.
 *
 * A one-field copy for one field: spreading `entry` and overwriting `headSha`
 * would have to spell out "unchanged" for every other field to say it, and
 * `appendLedgerEntry` stamps the row after this returns — a rebuilt object would
 * silently choose which of its own fields survive. Deleting a field is only
 * possible on a copy of `entry`, hence the two arms.
 */
function bumpCarryHead(
  entry: LedgerEntry,
  completed: boolean,
  existing: LedgerEntry[],
): LedgerEntry {
  if (completed) return entry;
  const headSha = incompleteHeadSha(existing, entry.branch);
  if (headSha === undefined) {
    const { headSha: _dropped, ...rest } = entry;
    return rest;
  }
  return { ...entry, headSha };
}
