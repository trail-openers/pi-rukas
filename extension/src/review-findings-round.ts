/**
 * review-findings-round — one round's decisions over the findings store
 * (#1105, #1125), split from review-findings-store.ts (AGENTS.md §12 file-size
 * gate). The store owns the file, the lock, the acceptance transition and this
 * round's head reads; this module owns the matching half: for each finding of a
 * round, the row it belongs to, whether it is suppressed, and for each untouched
 * open row, whether `rowFate` resolves or carries it.
 *
 * It is pure with respect to disk and git: the store supplies the branch's rows
 * and the head state per path, so every rule here is a function of the round's
 * findings, those rows, and the head lines. That is also what makes the fate of
 * a row testable without a clone.
 *
 * The one rule it does NOT own is a row's fate: an untouched open row resolves
 * or carries exactly as `rowFate` (review-findings-fate.ts) says. Callers must
 * not read a second resolve/carry rule into this file.
 */

import type { CarriedFinding, Finding } from "./lens-review-types.ts";
import type { ChangedRanges } from "./review-diff.ts";
import {
  type ReviewKind,
  isRetirableOpenCriticalRow,
  outsideDelta,
  rowFate,
} from "./review-findings-fate.ts";
import type { ConfirmationLapse } from "./review-findings-store-types.ts";
import { type LedgerEntry } from "./review-ledger-entry.ts";
import { confirmationsFor } from "./review-confirmation.ts";
import type {
  Decision,
  ResolvedNotice,
  SetAsideNotice,
  StoredFinding,
} from "./review-findings-file.ts";
import { newRowId } from "./review-findings-file.ts";
import type { HeadState } from "./review-findings-head.ts";
import { type FindingIdentity, identityOf, pickMatch, sameTitle } from "./review-findings-match.ts";

/** What this round decided about one finding, aligned by index with its input. */
export type { Decision } from "./review-findings-file.ts";

/** What one round's pass over the rows produced. */
export interface RoundOutcome {
  /** One decision per input finding, in the findings' order. */
  decisions: Decision[];
  /** Open rows this round neither matched nor resolved: they still stand. */
  carried: CarriedFinding[];
  /** Open rows this round resolved, with the reason `rowFate` gave. */
  resolved: ResolvedNotice[];
  /** Rows this round set aside: a lapsed acceptance, or a malformed row. */
  setAside: SetAsideNotice[];
  /**
   * #1934 AC4 — rows whose independent confirmation lapsed this round (see
   * `ConfirmationLapse` in review-findings-store.ts, which this mirrors): the
   * row is carried and stays `open`, and `confirmationLapsed` is written onto it
   * so the state survives the round.
   */
  lapsed?: ConfirmationLapse[];
}

/** The head state of one path, as read by the store before the round ran. */
export type HeadOf = (path: string) => HeadState | undefined;

/** The commit identity a confirmation must bind to, and the ledger rows the
 * confirmation is read from (#1934). */
export interface ConfirmationSource {
  /** The branch's ledger rows, as read by the store before the round ran. */
  ledger: readonly LedgerEntry[];
  /** The patch id of the range this round reviewed. */
  patchId: string;
  /** The full 40-char head this round reviewed. */
  headSha: string;
}

/** The row with its acceptance withdrawn: open again, so it is reported again. */
function reopen(r: StoredFinding): StoredFinding {
  return { ...r, status: "open", acceptance: undefined, resolvedReason: undefined };
}

/**
 * Match a round's findings to the branch's rows and decide every row's fate.
 *
 * Suppression (CRITICAL is never suppressed):
 *   - `suppressed-accepted`: the matched row is accepted, the title agrees, and
 *     for a line-bearing finding the cited code still has the accepted snippet;
 *   - `suppressed-unchanged`: a delta round, the title agrees, the cited code's
 *     snippet is unchanged, and the cited line lies outside the delta.
 * A finding on a path missing or invalid at head is never suppressed (there is
 * no code it could be unchanged against), and is recorded as a no-line finding.
 * An accepted row whose snippet changed lapses to open, is reported again, and
 * is named in `setAside`: an acceptance an operator recorded is an operator
 * decision, and its lapse is not silently the next round's business.
 *
 * `mine` is mutated in place (the store writes the array back), so the caller
 * owns the rows it passes in.
 */
export function applyFindingRound(opts: {
  branch: string;
  findings: Finding[];
  /** The branch's stored rows, mutated in place with this round's updates. */
  mine: StoredFinding[];
  /** Ids already taken across the whole file, so a new row id never collides. */
  taken: ReadonlySet<string>;
  headOf: HeadOf;
  review: ReviewKind;
  /** The delta's changed line ranges; required for a delta round to resolve anything. */
  deltaRanges?: ChangedRanges;
  /**
   * #1934 — the ledger rows and the commit identity an independent confirmation
   * is read against. Absent (the default, and every caller that has no ledger
   * to hand) means NO confirmation is consulted: rows retire exactly as before,
   * so a caller that does not thread this cannot accidentally gain the arm.
   * Present but unmatching also retires nothing — see review-confirmation.ts.
   */
  confirmations?: ConfirmationSource;
  now: number;
}): RoundOutcome {
  const { branch, findings, mine, headOf, review, deltaRanges, now, confirmations } = opts;
  // A working copy of the taken ids: a new row's id must not collide with an
  // earlier new row of the SAME round, and the caller's set stays untouched.
  let taken = new Set(opts.taken);
  const touched = new Set<string>();
  const decisions: Decision[] = [];
  const carried: CarriedFinding[] = [];
  const confirmationLapses: ConfirmationLapse[] = [];
  const resolved: ResolvedNotice[] = [];
  // An acceptance that lapsed this round: reported again (below) AND named for
  // the operator, because the suppression it provided is gone.
  const lapsed: SetAsideNotice[] = [];
  // A path absent at head (or not a file at head) has no line to cite: the
  // finding is a no-line one, and it is never suppressed.
  const noFile = (p: string) => {
    const head = headOf(p);
    return head !== undefined && !headHasFile(head);
  };
  const linesOf = (p: string): string[] => {
    const head = headOf(p);
    return head?.kind === "lines" ? head.lines : [];
  };

  // #1934 — the confirmations this round may act on. Only a COMPLETE FULL round
  // asks: the evidence is "an independent review covered this commit", and a
  // delta covered only its own range while an incomplete round reached no
  // verdict, so neither can vouch for the commit a confirmation binds to.
  const reviewable = review === "full" ? confirmations : undefined;
  /** The confirmation for one row, bounded by the row's own stamps.
   *
   * `confirmationsFor` asks whether the ledger row binds to the reviewed commit
   * and to this row; this adds the two facts only the round itself can supply,
   * enforced here rather than trusted from the caller because the one outcome
   * the rule must never produce is a CRITICAL the lenses still see disappearing
   * from the store:
   *
   *   - `firstSeen < now` — the row predates this round, so the confirmation is
   *     evidence about a review that came AFTER the finding was filed (#1934
   *     decision 1: a LATER round is what confirms a fix);
   *   - `lastSeen < now` — this round did NOT re-report it. The findings pass
   *     above stamps `lastSeen: now` on every matched row, so a re-reported row
   *     fails here even when a confirmation was written seconds before the
   *     lenses reported it. A row the round did not touch keeps the `lastSeen`
   *     an earlier round stamped, so a genuine confirmation — recorded after
   *     that round and before this one — still passes.
   */
  
const confirmedFor = (r: StoredFinding): string | undefined => {
    if (reviewable === undefined) return undefined;
    if (r.firstSeen >= now) return undefined;
    // A row this round RE-REPORTED has its `lastSeen` already stamped to `now`
    // by the findings pass above, and that stamp is not information about when
    // the finding was last observed — the round itself just wrote it. The real
    // bound for such a row is the round's own clock: a confirmation written
    // after this round started is evidence recorded while (or after) the lenses
    // were reporting the finding, and it confirms nothing. A row the round did
    // not touch keeps an older `lastSeen`, and any confirmation recorded after
    // that is evidence about a review that came later.
    const lastSeen = r.lastSeen >= now ? now : r.lastSeen;
    return confirmationsFor(
      reviewable.ledger,
      branch,
      { patchId: reviewable.patchId, headSha: reviewable.headSha },
      { firstSeen: r.firstSeen, lastSeen },
    ).get(r.id);
  };

  // #1934 AC4 — a retirement is not a latch. A row a previous round retired on a
  // confirmation is put back on the table by THIS round when (a) the round is a
  // complete full one, so it actually looked at the commit, and (b) the
  // confirmation no longer binds — same patchId and headSha absent, the row
  // un-passed, or the confirmation gone from the ledger. The row itself is not
  // touched: same `line`, same `lineHash`, same `firstSeen` — the row that was
  // retired is the row that comes back, and only the evidence changed. A row
  // that a confirmation retired and whose confirmation still binds is left alone
  // (the matched pass below resolves it again), and a row nobody ever retired is
  // untouched, which is every row in every round before this issue existed.
  if (reviewable !== undefined) {
    mine.forEach((r, i) => {
      if (r.status !== "resolved" || r.resolvedReason !== "confirmed") return;
      if (r.lastSeen >= now) return;
      const stillBindsQ = confirmationsFor(
        reviewable.ledger,
        branch,
        { patchId: reviewable.patchId, headSha: reviewable.headSha },
        { firstSeen: r.firstSeen, lastSeen: r.lastSeen },
      );
      const stillBinds =
        confirmationsFor(
          reviewable.ledger,
          branch,
          { patchId: reviewable.patchId, headSha: reviewable.headSha },
          { firstSeen: r.firstSeen, lastSeen: r.lastSeen },
        ).get(r.id) !== undefined;
      if (stillBinds) return;
      // Two sources for the notice, and the rule is one: a row whose retirement
      // was made by a confirmation is this driver's own, so its lapse is reportable.
      // `confirmedBy` is the field that says so (written by both retirement sites
      // and refused by the file's schema for any other reason), so it is the gate —
      // and a row that already carries the notice is not re-stamped, because the
      // array would grow every round and the disclosure would stop being about an
      // event.
      if (r.confirmationLapsed === true) return;
      const provenance = r.confirmedBy;
      if (provenance === undefined) return;
      // The row comes back EXACTLY as it stood — `reopen` clears the retirement
      // and nothing else, so `line`, `lineHash` and `firstSeen` are the row's
      // own — and it carries the notice that says why: a row whose retirement
      // was made by a confirmation and whose confirmation no longer binds is
      // open on changed evidence, not on its original filing.
      // `confirmedBy` CANNOT survive the reopen: the file's schema refuses a row
      // carrying provenance without the confirmed resolve reason (rowProblem in
      // review-findings-file.ts), and the row is open again. So the provenance
      // lives in the NOTICE this round reports, and the row carries only the
      // boolean — which is what the store's reader accepts on an open row.
      mine[i] = {
        ...reopen(r),
        confirmedBy: undefined,
        confirmationLapsed: true,
      };
      confirmationLapses.push({ rowId: r.id, title: r.title, provenance });
    });
  }
  const normalised = findings.map((f) => (noFile(f.path) ? { ...f, line: undefined } : f));
  const identities = normalised.map((f) => identityOf(f, linesOf(f.path)));
  // The explicit no-line marker (#1469), derived from the IDENTITY rather than
  // the payload: identityOf already folds in every way a finding can end up
  // without a resolvable line - the lens omitted it, the path is not a readable
  // file at head, or the cited line is past the file's end - so the marker says
  // "this row cites no code" for all three, not just the first.
  normalised.forEach((f, findingIndex) => {
    // The slot this row is written back to. NOT the finding's index into
    // `findings` — the two arrays are unrelated, and writing a re-reported row at
    // the finding's index wrote it onto whichever row happened to sit there while
    // leaving the real row untouched. Set once `pickMatch` has returned the row by
    // reference, so `indexOf` finds it by identity.
    let i = -1;
    const id = identities[findingIndex] as FindingIdentity;
    const critical = f.severity === "CRITICAL";
    const gone = noFile(f.path);
    const row = pickMatch(id, mine);
    if (row !== undefined) {
      // `pickMatch` returned a slot of `mine` by reference, so the index is found
      // by identity — the ONLY correct write-back target for a re-reported row.
      i = mine.indexOf(row);
    }
    if (!row) {
      const fresh: StoredFinding = {
        id: newRowId(taken),
        branch,
        path: f.path,
        anchor: id.anchor,
        titleClass: id.titleClass,
        title: f.title,
        // The prose rides with the row: a row carried in a later round is
        // rendered from the row alone, and an empty line under a finding heading
        // is what a row without it looked like (#1130).
        ...(f.description ? { description: f.description } : {}),
        ...(f.suggestion ? { suggestion: f.suggestion } : {}),
        severity: f.severity,
        lens: f.lens,
        ...(f.line ? { line: f.line } : {}),
        ...(id.hasLine ? {} : { noLine: true as const }),
        snippetHash: id.snippetHash,
        ...(id.lineHash ? { lineHash: id.lineHash } : {}),
        status: "open",
        firstSeen: now,
        lastSeen: now,
      };
      taken = new Set([...taken, fresh.id]);
      mine.push(fresh);
      touched.add(fresh.id);
      decisions.push({ action: "new", rowId: fresh.id });
      return;
    }
    touched.add(row.id);
    // Suppression needs the titles to agree too (see sameTitle): a snippet match
    // alone can be a different finding on the same line.
    const same = sameTitle(id, row);
    // The snippet the row was last recorded with. A changed neighbour line
    // changes the ±2 window, so an unchanged-code suppression needs this equal.
    const priorHash = row.snippetHash;
    let kept: StoredFinding = {
      ...row,
      lastSeen: now,
      snippetHash: id.snippetHash,
      lineHash: id.lineHash ?? row.lineHash,
      // Written conditionally, never as `line: f.line`: an own property whose
      // value is `undefined` still appears in `Object.keys`, so a re-reported
      // line-less finding would have written the field back onto a row that had
      // none — the exact shape divergence between the two row sites that made a
      // row's fate depend on whether it had ever been re-reported (#1469).
      ...(f.line ? { line: f.line } : {}),
      // The marker is written at BOTH row sites: had only the new-row site
      // carried it, the same divergence would appear in reverse, and the fate
      // rule reads the row, not its history.
      ...(id.hasLine ? {} : { noLine: true as const }),
      // The newest report of the finding is the freshest prose for it.
      ...(f.description ? { description: f.description } : {}),
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    };
    // #1934 AC4 — a row the round RE-REPORTED while it was still retired was
    // reopened by `reopen` below, and a re-report is the strongest form of "the
    // evidence no longer holds": the lenses are reporting this problem right now.
    // So the reopen carries the lapse notice — and only for a retirement THIS
    // driver made by confirmation (`confirmedBy`, which the file's schema ties to
    // the confirmed resolve reason), never for the ordinary reopen of a row some
    // other rule resolved.
    const lapseOnReopen =
      row.status === "resolved" &&
      row.resolvedReason === "confirmed" &&
      row.confirmedBy !== undefined;
    const lapsedProvenance = lapseOnReopen ? row.confirmedBy : undefined;
    if (kept.status === "resolved") kept = reopen(kept);
    // #1934 AC1 — a row this round RE-REPORTED. A re-report is the lenses saying
    // the problem is still there, so nothing retires on hash evidence: the cited
    // line is byte-unchanged by construction, and #1832's rule already refuses to
    // retire a re-reported CRITICAL on hashes. What retires it is an INDEPENDENT
    // confirmation bound to this exact commit, and the round that consumed it
    // needs no further work (AC1's "no further work needed"). The eligibility
    // test is `rowFate`'s own arm, called rather than re-spelled: a re-reported
    // row whose cited code survives retires on a confirmation and nothing else,
    // so the round asks `rowFate` what it would make of the row WITH the
    // confirmation and acts only on its answer. A row with no confirmation is
    // carried exactly as it was before this issue existed.
    if (
      kept.status === "open" &&
      isRetirableOpenCriticalRow(kept) &&
      // Re-reported means the round just stamped `lastSeen: now`, so the
      // confirmation must be older than the round's own clock: a confirmation
      // recorded after this round began is evidence written while the lenses were
      // still reporting the finding, and it confirms nothing.
      (() => {
        const cb = confirmedFor(kept);
        if (cb === undefined) return false;
        const head = headOf(kept.path);
        if (head === undefined) return false;
        return (
          rowFate(kept, head, review, { deltaRanges, confirmedBy: cb }).kind === "resolve"
        );
      })()
    ) {
      const cb = confirmedFor(kept) as string;
      // The re-report's own stamps are kept — the row's history is not rewritten
      // by a retirement — and the retirement notice is written here rather than
      // left over from an earlier retirement.
      kept = {
        ...kept,
        status: "resolved",
        acceptance: undefined,
        resolvedReason: "confirmed",
        confirmedBy: cb,
        confirmationLapsed: undefined,
      };
      resolved.push({ rowId: kept.id, title: kept.title, reason: "confirmed" });
      // The matched-row bookkeeping is unchanged: the row WAS matched, and its
      // retirement is recorded in `resolved`, not by rewriting what this round
      // observed.
      decisions.push({ action: "matched", rowId: kept.id });
      // `kept` is a `let` and the assignment above does not persist past this
      // callback, so the row is written back explicitly — the same site the
      // suppression paths below use.
      mine[i] = kept;
      return;
    }
    // #1934 AC4 — a row the round RE-REPORTED is evidence the problem is still
    // there, so any confirmation that had retired it is no longer evidence about
    // it: the lapse notice goes with the retirement rather than claiming a row
    // the lenses are reporting right now was once confirmed fixed.
    if (kept.confirmationLapsed !== undefined) kept = { ...kept, confirmationLapsed: undefined };
    if (lapseOnReopen && lapsedProvenance !== undefined) {
      kept = { ...kept, confirmationLapsed: true };
      confirmationLapses.push({ rowId: kept.id, title: kept.title, provenance: lapsedProvenance });
    }
    // A line-bearing finding is bound to the snippet the operator accepted; a
    // no-line finding is bound to its title only (see sameTitle).
    if (
      kept.status === "accepted" &&
      id.hasLine &&
      kept.acceptance.snippetHash !== id.snippetHash
    ) {
      lapsed.push({
        rowId: kept.id,
        path: kept.path,
        severity: kept.severity,
        title: kept.title,
        wasAcceptance: true,
      });
      kept = reopen(kept);
    }
    // Written by INDEX, not by `mine.indexOf(row)`: the lapse pass above may have
    // replaced this slot with an opened copy, and `indexOf` would then find no
    // match and silently drop the round's decision for the row (#1934).
    mine[mine.indexOf(row) === -1 ? i : mine.indexOf(row)] = kept;
    // An accepted row's suppression does NOT depend on its path being a readable
    // file: a no-line row on a path missing at head is suppressed by title like
    // any other, and a finding on a path the operator has set aside must not come
    // back every round. Eviction of a row whose path is gone happens in the
    // untouched-row pass below, where the round did NOT re-report it — which is
    // the only case where silence about a path is evidence about it.
    if (kept.status === "accepted" && !critical && same && kept.acceptance !== undefined) {
      // The narrowing local is deliberately not named after the field: the
      // acceptance-WRITE boundary test in test-review-accept-layers.ts scans src
      // for that name being assigned outside the store, and this is a read.
      const record = kept.acceptance;
      decisions.push({
        action: "suppressed-accepted",
        rowId: kept.id,
        reason: `accepted by ${record.by}: ${record.reason}`,
      });
      return;
    }
    if (!critical && !gone && same && deltaRanges && priorHash === id.snippetHash) {
      const reason = `cited line ${f.line ?? "?"} is outside the delta since the last recorded review`;
      if (outsideDelta(f, id.hasLine, deltaRanges)) {
        decisions.push({ action: "suppressed-unchanged", rowId: row.id, reason });
        return;
      }
    }
    decisions.push({ action: "matched", rowId: row.id });
  });
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
  return {
    decisions,
    carried,
    resolved,
    setAside: lapsed,
    ...(confirmationLapses.length > 0 ? { lapsed: confirmationLapses } : {}),
  };
}

/** True when the head state names a readable file. */
function headHasFile(h: HeadState): boolean {
  return h.kind === "lines";
}
