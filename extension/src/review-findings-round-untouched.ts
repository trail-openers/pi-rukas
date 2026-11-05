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

import type { CarriedFinding, Finding } from "./lens-review-types.ts";
import { capUnprovenHighFinding } from "./lens-unproven-high.ts";
import type { ReproductionEvidence } from "./lens-unproven-high.ts";
import type { ChangedRanges } from "./review-diff.ts";
import { type ReviewKind, rowFate } from "./review-findings-fate.ts";
import type { StoredFinding } from "./review-findings-file.ts";
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
  confirmationLapses: ConfirmationLapse[];
  /** The round's confirmation lookup for one row; undefined when the round may not act on any. */
  confirmedFor: (row: StoredFinding) => string | undefined;
  /**
   * #2040 review (lens HIGH) — the round's per-child record of what ran, applied
   * to the rows it CARRIES. A carried row is judged by this round, not by the
   * round that filed it: a HIGH whose claimed reproduction no child of THIS
   * round ran comes back capped, and the cap is written onto the row as well as
   * reported, so the next round is not asked to re-litigate a claim the store
   * already holds at HIGH. Built by the caller from the lens children it owns —
   * this module reads no child.
   */
  evidence: ReproductionEvidence;
}

/**
 * The cap provenance and the evidence claim a finding carries, shaped for a
 * stored row (#2040; the both-sites rule #1469 established for `line`).
 *
 * BOTH row-write sites in the round apply it — a row created here and a row
 * re-reported here — because writing it at one site only makes a row's fate
 * depend on whether it had ever been re-reported, which is the exact divergence
 * #1469 recorded. Each field is spread conditionally rather than written as
 * `field: undefined`: an own property holding `undefined` still appears in
 * `Object.keys`, so a row the cap never touched would come back carrying a
 * marker it never earned.
 */
export function findingCapFields(
  f: Pick<Finding, "severityCapped" | "reproduction">,
): Pick<StoredFinding, "severityCapped" | "reproduction"> {
  return {
    ...(f.severityCapped ? { severityCapped: f.severityCapped } : {}),
    ...(f.reproduction ? { reproduction: f.reproduction } : {}),
  };
}

/**
 * The carried row this round reports, and the row it writes back.
 *
 * Built from the stored row first, then put through the unproven-HIGH cap with
 * THIS round's per-child evidence: a row is judged by the calls made now, not by
 * the ones made in the round that filed it. The cap returns the same object when
 * it moves nothing, so `mine[slot]` is written only for a row the cap actually
 * moved — which is what makes the row's severity a fact of THIS round rather
 * than of its history: a stored HIGH nobody ran a reproduction for must not be
 * HIGH for the round after next either.
 */
function carriedRow(
  r: StoredFinding,
  evidence: ReproductionEvidence,
  mine: StoredFinding[],
  slot: number,
): CarriedFinding {
  const judged = capUnprovenHighFinding(carriedFields(r), evidence);
  if (judged.severity !== r.severity) {
    // Same object, severity and marker swapped — no other field of the stored row
    // is touched (stamps, hashes, acceptance and provenance all stand).
    mine[slot] = {
      ...r,
      severity: judged.severity,
      ...(judged.severityCapped === undefined
        ? { severityCapped: undefined }
        : { severityCapped: judged.severityCapped }),
    };
  }
  return judged as CarriedFinding;
}

/**
 * A stored row read as the `Finding` shape a carried row is reported in.
 *
 * The cast is the store's side of a deliberate split: `Finding`'s `lens` is
 * `FindingSource` (a lens or `CLAIM_SCAN`), while a stored row's `lens` is the
 * unbounded string its reader keeps — the roster is data-driven (#873), so a
 * row filed by a lens this build's roster does not name still comes back and
 * still must be reported. `carriedFields` is the ONLY place the shape is built
 * (its return type is `CarriedFinding`, and the sole call site passes the result
 * to the cap and back), so the widening is checked here once rather than at
 * every consumer. The fields themselves are read straight off the row.
 */
function carriedFields(r: StoredFinding): CarriedFinding {
  return {
    carried: true,
    lens: r.lens,
    severity: r.severity,
    // The cap provenance is kept by the row rather than recomputed from the
    // path: a row the cap lowered in an earlier round must still read as a
    // capped row when it comes back, or it arrives looking like a finding the
    // lens itself called medium.
    ...(r.severityCapped === undefined ? {} : { severityCapped: r.severityCapped }),
    // #2040 — and the evidence the row stored, so a carried HIGH re-enters a
    // later round judgeable rather than blankly unproven.
    ...(r.reproduction === undefined ? {} : { reproduction: r.reproduction }),
    path: r.path,
    line: r.line,
    // A carried row keeps the marker it stored: it is still a file-level claim,
    // and the renderer's `:?` depends on the row saying so.
    ...(r.noLine === undefined ? {} : { noLine: r.noLine }),
    title: r.title,
    // A carried row is re-reported to the operator verbatim from the row: the
    // stored description rides along so it never renders empty (#1130).
    ...(r.description === undefined ? {} : { description: r.description }),
    ...(r.suggestion === undefined ? {} : { suggestion: r.suggestion }),
  } as CarriedFinding;
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
    confirmationLapses,
    confirmedFor,
    evidence,
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
      carried.push(carriedRow(r, evidence, mine, i));
      // #1934 — the AC4 lapse notice for an UNTOUCHED row is produced by the
      // `resolved` pass earlier in the round (review-findings-round.ts:233-260),
      // and this `else` arm can never produce one. Probed, not reasoned: driving
      // the real store path (a re-reported CRITICAL retired by a ledger row whose
      // `at` sits inside the row's `[firstSeen, lastSeen]` window, then rounds
      // that report NOTHING and whose confirmation no longer binds) fires the
      // lapse on the round where the row is still `resolved`+`confirmed`, and the
      // row comes back `open` with the notice already reported and no
      // `confirmedBy` on it. So the state this block judged — an `open` row that
      // still carries a retirement's provenance — is not a state the round ever
      // produces, and the `open` arm of `StoredFinding` now refuses to store it
      // either. The prior dispatch deleted it on a static-narrowing argument, and
      // static narrowing cannot prove a runtime state unreachable: the proof is
      // the probe above, and the block stays deleted so no future reader trusts
      // a lapse notice to come from here.
    }
  });
}
