/**
 * review-findings-round-ac4 — the "a retirement is not a latch" pass, split out
 * of review-findings-round.ts (AGENTS.md §12's 500-line gate) alongside the
 * untouched-row pass in review-findings-round-untouched.ts.
 *
 * The rule: a row a previous round retired on an independent confirmation comes
 * back on the table when THIS round is a complete full one that actually looked
 * at the commit AND the confirmation no longer binds — same patchId and headSha
 * absent, the row un-passed, or the confirmation gone from the ledger. The row
 * itself is not otherwise touched: same `line`, same `lineHash`, same
 * `firstSeen` — the row that was retired is the row that comes back, and only
 * the evidence changed. A row whose confirmation still binds is left alone (the
 * matched pass resolves it again), and a row nobody ever retired is untouched.
 *
 * The pass is a no-op for a round that may not consult confirmations at all,
 * which is every delta round and every incomplete one: the evidence a
 * retirement needs is "an independent review covered this commit", and neither a
 * delta (which covered only its own range) nor an unfinished round can supply it.
 */

import { confirmationsFor } from "./review-confirmation.ts";
import type { StoredFinding } from "./review-findings-file.ts";
import { reopen } from "./review-findings-reopen.ts";
import type { ConfirmationSource } from "./review-findings-round-confirmation.ts";
import type { ConfirmationLapse } from "./review-findings-store-types.ts";

export function applyConfirmationLapsePass(opts: {
  /** The branch's stored rows, mutated in place when a retirement lapses. */
  mine: StoredFinding[];
  /** The round's clock; a row stamped at or after it was seen BY this round. */
  now: number;
  /** The round's confirmation source, or undefined when it may consult none. */
  reviewable: ConfirmationSource | undefined;
  branch: string;
  /** The ids of the rows this round holds — the bound the ledger join needs. */
  heldRowIds: ReadonlySet<string>;
  /** Lapse notices land here; the round reports them as its `lapsed` field. */
  confirmationLapses: ConfirmationLapse[];
}): void {
  const { mine, now, reviewable, branch, heldRowIds, confirmationLapses } = opts;
  if (reviewable === undefined) return;
  mine.forEach((r, i) => {
    if (r.status !== "resolved" || r.resolvedReason !== "confirmed") return;
    if (r.lastSeen >= now) return;
    const stillBinds =
      confirmationsFor(
        reviewable.ledger,
        branch,
        { patchId: reviewable.patchId, headSha: reviewable.headSha },
        { firstSeen: r.firstSeen, lastSeen: r.lastSeen },
        heldRowIds,
      ).get(r.id) !== undefined;
    if (stillBinds) return;
    // Two sources for the notice, and the rule is one: a row whose retirement was
    // made by a confirmation is this driver's own, so its lapse is reportable.
    // `confirmedBy` is the field that says so (written by both retirement sites
    // and refused by the file's schema for any other reason), so it is the gate —
    // and a row that already carries the notice is not re-stamped, because the
    // array would grow every round and the disclosure would stop being about an
    // event.
    if (r.confirmationLapsed === true) return;
    const provenance = r.confirmedBy;
    if (provenance === undefined) return;
    // The row comes back EXACTLY as it stood — `reopen` clears the retirement and
    // nothing else, so `line`, `lineHash` and `firstSeen` are the row's own — and
    // it carries the notice that says why: a row whose retirement was made by a
    // confirmation and whose confirmation no longer binds is open on changed
    // evidence, not on its original filing.
    // `confirmedBy` CANNOT survive the reopen: the file's schema refuses a row
    // carrying provenance without the confirmed resolve reason (rowProblem in
    // review-findings-file.ts), and the row is open again. So the provenance lives
    // in the NOTICE this round reports, and the row carries only the boolean —
    // which is what the store's reader accepts on an open row.
    mine[i] = { ...reopen(r), confirmedBy: undefined, confirmationLapsed: true };
    confirmationLapses.push({ rowId: r.id, title: r.title, provenance });
  });
}
