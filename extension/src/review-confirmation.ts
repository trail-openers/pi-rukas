/**
 * review-confirmation — the commit-bound INDEPENDENT confirmation a review
 * finding row is retired on (#1934).
 *
 * The defect this closes: `rowFate` (review-findings-fate.ts) resolves an
 * untouched open row ONLY on evidence about its CITED LINE — its window hash
 * and its `lineHash` both gone from the head file. That rule is right about a
 * fix that edits the cited line and helpless about every other kind of fix. A
 * round-9 lens review on a live PR is the shape: a fix landed at
 * `test-pi-version-drift.ts:481` and the row citing `pi-version-census.ts:286`
 * could not retire, because "did the cited line change" cannot see a correct
 * fix somewhere else. `firstSeen == lastSeen` proves nothing — that is exactly
 * what a carried-and-blocking row looks like.
 *
 * So a row gets a second piece of evidence it can answer to, and it is the
 * strongest independent one the harness already produces: a LATER review round
 * — a passing adversarial verdict, or the named test's green — recorded against
 * the very commit the round under review is reviewing. A fix in a different
 * file changes what that round sees, so a confirmation whose identity matches
 * the round is evidence the fix is in the tree, which is the thing the cited
 * line cannot show.
 *
 * ## The binding, and why each half is load-bearing
 *
 * - `kind` is `"adversarial"` — the one independent review this harness records
 *   today. A `lens` row is never a confirmation: it is the round itself, and a
 *   round cannot confirm its own silence (that is #1832's failure). A green
 *   named test run is the second independent review the spec named; it is not in
 *   `CONFIRMING_KINDS` because nothing writes such a ledger row — see the note
 *   on that constant.
 * - `passed` is true — a failing round confirms nothing.
 * - `patchId` equals the round's own patch id, and `headSha` equals the round's
 *   head. Both, not either. `patchId` is content (the patch against the
 *   mainline merge-base) and `headSha` is position (which commit is the tip):
 *   a rebase moves one without the other. These are the same two fields the
 *   #912 merge guard checks, read the same way.
 * - the confirming round came AFTER the row was filed (`at >= firstSeen`) and
 *   did not itself report the finding (`at < lastSeen`, which the round under
 *   review stamped). An earlier "confirmation" confirms a tree that no longer
 *   exists, and a round that re-reported the finding is evidence the problem is
 *   still there, not that it was fixed — so such a row must not reach this
 *   code at all. `applyFindingRound` gates the confirmation on its own
 *   `review` and the row's hashes rather than trusting a caller to have
 *   filtered: a confirmation handed to a round that re-reported the row is the
 *   one shape that would retire a live CRITICAL.
 *
 * ## Why it is keyed on the ROW, not the branch
 *
 * `rowId` is the join. A passing adversarial row for a branch is not a
 * confirmation of anything about a particular finding, so this module returns
 * the provenance keyed on the row it proves, and the fate rule asks about one
 * row at a time. A confirmation for row A never retires row B.
 *
 * ## Fail-closed, in every direction
 *
 * No ledger, an unreadable ledger, no `patchId`, no `headSha`, a malformed
 * `headSha`, a `rowId` in any shape a ledger row is allowed to carry — all
 * answer NO confirmation, which is the same answer as "there is none". A fault
 * in the confirmation path can therefore never produce a resolution; it can
 * only fail to produce one. Nothing here throws.
 *
 * ## Trust boundary — read this before adding a producer
 *
 * A CONFIRMATION IS NOT A GATE. Nothing in this module or in the fate rule
 * decides whether a merge happens. What it decides is whether a row in the
 * findings memory is still `open`, and the row is `open` again the moment the
 * confirmation stops binding (AC4): the row, its cited code and the veto
 * (`vetoAutoDeltaForOpenCritical`) all come back, so the next round still has
 * to retire the row on cited-line evidence or not at all. Retirement also
 * never touches the recorded verdict or `hasCritical` on the lens ledger row —
 * those belong to the round that produced them, and `merge-guard-round-cap.ts`
 * reads those, not this. The strongest thing a forged confirmation can do is
 * make ONE round's disclosure list a row as resolved.
 *
 * The provenance string it writes is therefore worth reading honestly rather
 * than trusting: `adversarial#<row id> patch=<8> head=<8> round=<N>@<8>` is
 * written from the ledger row's own recorded fields, and a field the row lacked is
 * simply absent from it. Every segment names data the ledger already stores, so a
 * reader can go and check the row it came from. It is a DISCLOSURE, never a
 * comparison: no rule in this module reads the provenance back, and nothing that
 * decides a merge does.
 *
 * ## SECURITY rows
 *
 * Excluded, and excluded in the fate rule rather than the query, next to the
 * existing SECURITY carve-out (`SECURITY_LENS`) so the two carve-outs have one
 * home. A security row retires only when a complete full review proves its
 * cited code gone.
 */

import { isFullCommitSha } from "./review-head-sha.ts";
import type { LedgerEntry } from "./review-ledger.ts";

/** The review kinds that may confirm a fix. A `lens` row is the round itself.
 *
 * `"test"` is DELIBERATELY ABSENT, and the absence is a decision, not an
 * oversight: nothing in this repo writes a ledger row of that kind, and
 * `validEntries` (review-ledger-read.ts) drops any kind outside
 * `adversarial|lens` — so a `"test"` member here could never match a row that
 * survived the read. The missing half is the WRITER, not this list: a green
 * project test run is an independent review, but recording one is the lean
 * `toolPath` follow-up, which has to decide what a passing run binds to. Until
 * that writer exists the kind stays out, so the constant names only what
 * production can actually produce — a kind listed here with no writer is how a
 * dead path gets mistaken for a shipped one. */
const CONFIRMING_KINDS: readonly string[] = ["adversarial"];

/** A confirmation older than this many characters of provenance is not rendered. */
const PROVENANCE_MAX_CHARS = 160;

/** A 40-char oid rendered short enough to read on one disclosure line. */
function short(sha: string): string {
  return sha.slice(0, 8);
}

/** The row this confirmation proves, when a ledger row names one.
 *
 * `rowId` is not a field of `LedgerEntry` — the ledger's own schema forbids
 * nothing, so an untrusted file can carry one in any shape. Matched with the
 * store's own row-id rule (8 lowercase hex) rather than a `String(x)` cast:
 * `[object Object]` is not a row id and must not become a join key. */
function confirmedRowId(entry: LedgerEntry): string | undefined {
  const raw = (entry as { rowId?: unknown }).rowId;
  if (typeof raw !== "string") return undefined;
  return /^[0-9a-f]{8}$/.test(raw) ? raw : undefined;
}

/** What the round's own review must match for a confirmation to count. */
export interface ReviewedIdentity {
  /** The patch id of the range this round is reviewing (the same `git
   * patch-id --stable` answer the #912 writers store). */
  patchId: string;
  /** The full 40-char head this round is reviewing. */
  headSha: string;
}

/**
 * The confirmations on `branch`'s ledger that bind to `reviewed`, keyed by the
 * row each one proves.
 *
 * One read of the ledger, one pass. `at` is bounded per row by the rows
 * `latestEntry` would return (one per confirming kind), so the read is O(rows in
 * the file) and a branch with a long review history pays nothing extra: the
 * ledger keeps one row per (branch, kind) anyway.
 *
 * A row is a confirmation for row R when its kind is a confirming kind, it
 * passed, its `patchId` and `headSha` are both equal to the reviewed commit's,
 * it names R — and, when `rowIds` is given, R is one of the rows the calling
 * round holds — and it was written between R being filed and R last being
 * reported (see the module header). Anything else is not one — and the ledger
 * being unreadable is not one either. The read itself happens in the store
 * (review-findings-store.ts), whose own try/catch answers "no rows" for every
 * fault in resolving or parsing the file, so nothing here throws.
 */
export function confirmationsFor(
  entries: readonly LedgerEntry[],
  branch: string,
  reviewed: ReviewedIdentity,
  seen: { firstSeen: number; lastSeen: number },
  /** #1934 — the ids of the rows the calling round holds. When present, a
   * ledger row is a candidate ONLY when it names one of them: bounding the
   * join to the rows the round owns is what stops a stale rowId left in the
   * ledger by an earlier round from winning the per-kind race and hiding the
   * confirmation this round's own row needs. Absent (the default) the scan is
   * unbounded and behaviour is exactly as before, so a caller that does not
   * thread ids changes nothing. */
  rowIds?: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!reviewed.patchId || !reviewed.headSha || !branch) return out;
  // One pass over the file, keeping the LATEST passing row per confirming kind
  // (max `at`, the same selection `latestEntry` makes) — not `latestEntry` itself,
  // which returns the latest row of a kind whatever it says, so one later
  // un-passing row would hide a binding confirmation recorded under it.
  const best = new Map<string, LedgerEntry>();
  for (const e of entries) {
    if (e.branch !== branch || !e.passed) continue;
    if (!CONFIRMING_KINDS.includes(e.kind)) continue;
    // Skipped before the per-kind `best` race: a row naming a row this round
    // does not hold can never be selected, and letting it win the race would
    // hide a binding confirmation recorded under it.
    if (rowIds !== undefined) {
      const named = confirmedRowId(e);
      if (named === undefined || !rowIds.has(named)) continue;
    }
    const prev = best.get(e.kind);
    if (!prev || e.at >= prev.at) best.set(e.kind, e);
  }
  for (const entry of best.values()) {
    if (!entry) continue;
    if (entry.patchId !== reviewed.patchId) continue;
    // A stored headSha that is not a full oid is UNKNOWN, never matched: the
    // #1039 rule, applied to the comparison rather than to the render.
    if (!entry.headSha || !isFullCommitSha(entry.headSha)) continue;
    if (entry.headSha !== reviewed.headSha) continue;
    // After the row was filed, and before it was last reported. A round that
    // reported the finding is not a confirmation that it is gone.
    if (entry.at < seen.firstSeen || entry.at > seen.lastSeen) continue;
    const rowId = confirmedRowId(entry);
    if (!rowId) continue;
    out.set(
      rowId,
      [
        `${entry.kind}#${rowId}`,
        `patch=${short(entry.patchId)}`,
        `head=${short(entry.headSha)}`,
        entry.round === undefined ? "" : `round=${entry.round}@${short(entry.headSha)}`,
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, PROVENANCE_MAX_CHARS),
    );
  }
  return out;
}
