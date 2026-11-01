/**
 * review-findings-round-untouched — the half of a findings round that judges the
 * rows the round did NOT re-report (#1125; split out of review-findings-round.ts
 * for the AGENTS.md §12 size gate, which the #1934 confirmation passes pushed
 * past 500 lines).
 *
 * It owns no rule of its own: every resolve/carry/evict decision is `rowFate`'s
 * (review-findings-fate.ts), called rather than re-spelled, and the
 * #1934 confirmation lapse notice is the round's `confirmedFor` question asked of
 * a row nobody reported. Reading a second copy of those rules here is how the two
 * halves of a round start to disagree — the reason this file takes the round's
 * collections as arguments instead of deciding anything independently.
 */

import type { CarriedFinding } from "./lens-review-types.ts";
import type { ChangedRanges } from "./review-diff.ts";
import { type ReviewKind, rowFate } from "./review-findings-fate.ts";
import type { SetAsideNotice, StoredFinding } from "./review-findings-file.ts";
import type { ResolvedNotice } from "./review-findings-file.ts";
import type { HeadOf } from "./review-findings-round.ts";
import type { ConfirmationLapse } from "./review-findings-store-types.ts";

/** The round's output collections, filled in place. */
export interface UntouchedRowSinks {
  mine: StoredFinding[];
  touched: ReadonlySet<string>;
  headOf: HeadOf;
  review: ReviewKind;
  deltaRanges?: ChangedRanges;
  carried: CarriedFinding[];
  resolved: ResolvedNotice[];
  lapsed: SetAsideNotice[];
  confirmationLapses: ConfirmationLapse[];
  /** The round's confirmation lookup for one row; undefined when the round may not act on any. */
  confirmedFor: (row: StoredFinding) => string | undefined;
}

export function applyUntouchedRowFate(opts: UntouchedRowSinks): void {
  const {
    mine,
    touched,
    headOf,
    review,
    deltaRanges,
    carried,
    resolved,
    lapsed,
    confirmationLapses,
    confirmedFor,
  } = opts;
  mine.forEach((r, i) => {
    if (r.status === "accepted") {
      // #1125 — an acceptance does not immortalise a row. An UNTOUCHED accepted
      // row goes through the SAME rule as an untouched open row: `rowFate`, with
      // the same head state and the same delta ranges. A row whose path is absent
      // at head is therefore evicted (`path-gone`) rather than kept alive forever
      // by its acceptance — the set-aside was about code that exists, and code
      // that is not in the tree has nothing to set aside — while an INVALID path
      // (unsafe spelling, a directory/tree) has no automatic exit and a DELTA
      // round, which never saw the deletion, carries it. Those are not rules this
      // file adds: they are `rowFate`'s, and reading a second copy of them here
      // is how the two halves of a round start to disagree.
      if (!touched.has(r.id)) {
        // A row whose path the store never read (added after the round's head
        // read) has no evidence, and `rowFate` carries it exactly as the open-row
        // branch below does — an accepted row is never evicted on absence of
        // evidence, only on proof.
        const head = headOf(r.path);
        const fate =
          head === undefined
            ? ({ kind: "carry" } as const)
            : rowFate(r, head, review, { deltaRanges });
        if (fate.kind === "resolve") {
          mine[i] = {
            ...r,
            status: "resolved",
            acceptance: undefined,
            resolvedReason: fate.reason,
            // #1934 — an ACCEPTED row never reaches the confirmation arm: the
            // arm tests `status === "open"`, so this resolve reason is never
            // "confirmed" and the provenance below must be cleared rather than
            // inherited from a row that had been retired by a confirmation and
            // was re-accepted since (review-findings-file.ts's rowProblem
            // refuses a row carrying provenance without that reason).
            confirmedBy: undefined,
          };
          resolved.push({ rowId: r.id, title: r.title, reason: fate.reason });
        }
      }
      return;
    }
    if (r.status !== "open" || touched.has(r.id)) return;
    // Open rows' paths are read by the store before the round ran. A row added
    // concurrently (after that read, before the mutate re-read the file under the
    // lock) has no head state. Carrying it is the safe outcome: nothing is
    // resolved on evidence never read.
    const head = headOf(r.path);
    const confirmedBy = confirmedFor(r);
    const fate =
      head === undefined
        ? ({ kind: "carry" } as const)
        : rowFate(r, head, review, {
            deltaRanges,
            ...(confirmedBy === undefined ? {} : { confirmedBy }),
          });
    if (fate.kind === "resolve") {
      mine[i] = {
        ...r,
        status: "resolved",
        acceptance: undefined,
        resolvedReason: fate.reason,
        ...(fate.reason === "confirmed" && confirmedBy !== undefined ? { confirmedBy } : {}),
        // A retirement erases the lapse notice: the row is retired, and a
        // "lapsed" flag beside a resolved row would read as two histories.
        confirmationLapsed: undefined,
      };
      resolved.push({
        rowId: r.id,
        title: r.title,
        reason: fate.reason,
        ...(fate.reason === "confirmed" && confirmedBy !== undefined ? { confirmedBy } : {}),
      });
    } else {
      // #1934 AC4 — the confirmation is RE-EVALUATED every round, never latched
      // at first match: this is the round on which the row's confirmation did NOT
      // bind, so a row a previous round retired on it is carried. The row itself
      // is unchanged — same `line`, same `lineHash`, still `open` — what changed
      // is the evidence, and a later reader must be able to tell that apart from
      // a row that was never retired. So the row gains `confirmationLapsed`, and
      // the round reports it. `retiredOn` names the confirmation it was retired
      // on (the string the row carried while it stood), so the disclosure is a
      // statement about a real review and not "something changed". A row nobody
      // ever retired carries no field and is not listed.
      carried.push({
        carried: true,
        lens: r.lens,
        severity: r.severity,
        path: r.path,
        line: r.line,
        // A carried row keeps the marker it stored: it is still a file-level
        // claim, and the renderer's `:?` depends on the row saying so.
        ...(r.noLine === undefined ? {} : { noLine: r.noLine }),
        title: r.title,
        // A carried row is re-reported to the operator verbatim from the row: the
        // stored description rides along so it never renders empty (#1130).
        ...(r.description === undefined ? {} : { description: r.description }),
        ...(r.suggestion === undefined ? {} : { suggestion: r.suggestion }),
      });
      if (r.confirmationLapsed === undefined && r.confirmedBy !== undefined) {
        mine[i] = { ...r, confirmationLapsed: true };
        confirmationLapses.push({ rowId: r.id, title: r.title, provenance: r.confirmedBy });
      }
    }
  });
}
