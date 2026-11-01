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
 * - `kind` is `"adversarial"` or `"test"` — the two independent reviews the
 *   spec named. A `lens` row is never a confirmation: it is the round itself,
 *   and a round cannot confirm its own silence (that is #1832's failure).
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
 * than trusting: `adversarial#<rowNonce> patch=<8> head=<8> round=<N>@<8>` is
 * written from the ledger row's own fields, and the fields it lacked are simply
 * absent from it. `rowNonce` in particular is TEST-FACING provenance
 * (`LedgerEntry.rowNonce`) and the merge guard is forbidden to consult it; here
 * it is rendered for a human, never compared.
 *
 * ## SECURITY rows
 *
 * Excluded, and excluded in the fate rule rather than the query, next to the
 * existing SECURITY carve-out (`SECURITY_LENS`) so the two carve-outs have one
 * home. A security row retires only when a complete full review proves its
 * cited code gone.
 */

import { execp } from "./exec.ts";
import { isFullCommitSha } from "./review-head-sha.ts";
import { type LedgerEntry, latestEntry, ledgerPathFor, readLedgerAt } from "./review-ledger.ts";
import { trace } from "./trace.ts";

/** The two review kinds that may confirm a fix. A `lens` row is the round itself. */
const CONFIRMING_KINDS: readonly string[] = ["adversarial", "test"];

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
 * One read of the ledger, one pass. `at` is bounded per row by the two rows
 * `latestEntry` would return (the latest adversarial and the latest test row),
 * so the read is O(rows in the file) and a branch with a long review history
 * pays nothing extra: the ledger keeps one row per (branch, kind) anyway.
 *
 * A row is a confirmation for row R when its kind is one of the two confirming
 * kinds, it passed, its `patchId` and `headSha` are both equal to the reviewed
 * commit's, it names R, and it was written between R being filed and R last
 * being reported (see the module header). Anything else is not one — and the
 * ledger being unreadable is not one either.
 */
export function confirmationsFor(
  entries: readonly LedgerEntry[],
  branch: string,
  reviewed: ReviewedIdentity,
  seen: { firstSeen: number; lastSeen: number },
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

/**
 * Read the branch's ledger and answer the same question. Never throws: an
 * unresolved ledger path, a missing file and an unreadable file all answer "no
 * confirmations", which is the answer that retires nothing.
 */
export async function confirmationsForBranch(
  cwd: string,
  branch: string,
  reviewed: ReviewedIdentity,
  seen: { firstSeen: number; lastSeen: number },
): Promise<Map<string, string>> {
  let file: string | undefined;
  try {
    file = await ledgerPathFor(execp, cwd);
  } catch (err) {
    trace(
      `review-confirmation: ledger path unresolved: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Map();
  }
  if (!file) return new Map();
  let entries: LedgerEntry[];
  try {
    entries = readLedgerAt(file);
  } catch (err) {
    trace(
      `review-confirmation: ledger unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Map();
  }
  return confirmationsFor(entries, branch, reviewed, seen);
}
