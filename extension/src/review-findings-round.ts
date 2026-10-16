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

import type { Finding } from "./lens-review-types.ts";
import type { ChangedRanges } from "./review-diff.ts";
import { type ReviewKind, outsideDelta, rowFate } from "./review-findings-fate.ts";
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
  carried: Finding[];
  /** Open rows this round resolved, with the reason `rowFate` gave. */
  resolved: ResolvedNotice[];
  /** Rows this round set aside: a lapsed acceptance, or a malformed row. */
  setAside: SetAsideNotice[];
}

/** The head state of one path, as read by the store before the round ran. */
export type HeadOf = (path: string) => HeadState | undefined;

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
  now: number;
}): RoundOutcome {
  const { branch, findings, mine, headOf, review, deltaRanges, now } = opts;
  // A working copy of the taken ids: a new row's id must not collide with an
  // earlier new row of the SAME round, and the caller's set stays untouched.
  let taken = new Set(opts.taken);
  const touched = new Set<string>();
  const decisions: Decision[] = [];
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
  const normalised = findings.map((f) => (noFile(f.path) ? { ...f, line: undefined } : f));
  const identities = normalised.map((f) => identityOf(f, linesOf(f.path)));
  normalised.forEach((f, i) => {
    const id = identities[i] as FindingIdentity;
    const critical = f.severity === "CRITICAL";
    const gone = noFile(f.path);
    const row = pickMatch(id, mine);
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
      line: f.line,
      // The newest report of the finding is the freshest prose for it.
      ...(f.description ? { description: f.description } : {}),
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    };
    if (kept.status === "resolved") kept = reopen(kept);
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
    mine[mine.indexOf(row)] = kept;
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
  const carried: Finding[] = [];
  const resolved: ResolvedNotice[] = [];
  mine.forEach((r, i) => {
    if (r.status === "accepted") {
      // #1125 — an acceptance does not immortalise a row. A row whose path is
      // ABSENT from the reviewed commit is evicted exactly as an open row is: the
      // set-aside was about code that exists, and code that is not in the tree
      // has nothing to set aside. Two restrictions, both from rowFate's own
      // doctrine: only a FULL round may do it (a delta's silence about a path is
      // not evidence the path is gone), and only `missing` counts — an INVALID
      // path (unsafe spelling, or a directory/tree) has no automatic exit at all,
      // so its accepted rows carry rather than being evicted.
      if (!touched.has(r.id) && review === "full" && headOf(r.path)?.kind === "missing") {
        const fate = rowFate(r, { kind: "missing" }, review, { deltaRanges });
        if (fate.kind === "resolve") {
          mine[i] = {
            ...r,
            status: "resolved",
            acceptance: undefined,
            resolvedReason: fate.reason,
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
    const fate =
      head === undefined ? ({ kind: "carry" } as const) : rowFate(r, head, review, { deltaRanges });
    if (fate.kind === "resolve") {
      mine[i] = { ...r, status: "resolved", acceptance: undefined, resolvedReason: fate.reason };
      resolved.push({ rowId: r.id, title: r.title, reason: fate.reason });
    } else {
      carried.push({
        lens: r.lens,
        severity: r.severity,
        path: r.path,
        line: r.line,
        title: r.title,
        // A carried row is re-reported to the operator verbatim from the row: the
        // stored description rides along so it never renders empty (#1130).
        ...(r.description === undefined ? {} : { description: r.description }),
        ...(r.suggestion === undefined ? {} : { suggestion: r.suggestion }),
      });
    }
  });
  return { decisions, carried, resolved, setAside: lapsed };
}

/** True when the head state names a readable file. */
function headHasFile(h: HeadState): boolean {
  return h.kind === "lines";
}
