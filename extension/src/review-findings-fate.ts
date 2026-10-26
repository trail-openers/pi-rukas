/**
 * review-findings-fate — the ONE resolve/carry rule for an untouched open
 * findings row (#1125 first slice, #1130, round-2 #1300). The store
 * (review-findings-store.ts) calls `rowFate` for every open row the round did
 * not match; nothing else decides a row's fate.
 *
 * Decision order, first match wins:
 *   1. The row's path is absent at head → `resolve("path-gone")` on a complete
 *      full review, else `carry`.
 *   2. No usable line (no stored line, the empty-snippet hash, or no head lines)
 *      → `resolve("not-reported")` on a complete full review that no longer
 *      reports it (#1469), else `carry`. See `linelessFate` for why silence is
 *      evidence for THIS class of row and for no other.
 *   3. The row's ±2-line window hash is found at ANY line of the head file →
 *      `carry`. Something near the cited code changed; the code did not.
 *   4. The row's cited-line hash (`lineHash`) is found at ANY line of the head
 *      file → `carry`. The cited line itself still exists, possibly moved.
 *   5. The cited line is past the end of the head file → `resolve("line-past-eof")`
 *      on a complete full review, else `carry`.
 *   6. A CRITICAL row retires ONLY on a complete full review that no longer
 *      reports it and whose head lacks BOTH its window hash and its cited-line
 *      hash → `resolve("code-gone")`; on a delta or an incomplete round it
 *      `carry`s (#1832). Before #1832 this arm was an unconditional `carry`, and
 *      one since-fixed CRITICAL kept every later verdict blocking forever.
 *   7. A row with no `lineHash` (written before the field existed, or a CRITICAL
 *      whose cited line was never hashable) cannot prove its cited line changed
 *      → `carry`. This carry still applies to a CRITICAL: no hash, no proof.
 *   8. On a DELTA round, the row's cited line falls outside the delta's changed
 *      line ranges → `carry`. The round saw neither the code nor a re-report of
 *      it, so it has no evidence either way (#1125 decision 5).
 *   9. The cited line itself is gone from the head file → `resolve("code-gone")`
 *      when the round reviewed that line: a complete full review, or a delta
 *      round whose changed ranges hold the stored line (a SECURITY row never
 *      resolves on a delta). Otherwise `carry`.
 *
 * The only resolving rule for a changed line is step 9: a row resolves when its
 * CITED LINE changed, never on a window edit alone. A trivial edit to a
 * neighbouring line (a comment inserted in the ±2 window) therefore cannot clear
 * a finding by omission.
 *
 * Trust assumption: step 9 resolves a row whose cited line changed with no
 * re-report. That is safe only because the round covered that line and
 * re-reported a finding that is still real — a lens that still sees the problem
 * reports it again and the row is matched, not resolved. On a delta round the
 * coverage is the delta alone, which is why step 8 restricts the rule to the
 * lines the round actually reviewed.
 *
 * Pure: the caller supplies the row, the head state, the review kind and (for a
 * delta round) the changed line ranges. An incomplete review never resolves a
 * row; it carries it. A delta resolves nothing outside its own changed lines.
 *
 * An invalid path (unsafe, or a directory/tree at head) has NO automatic exit:
 * its rows are carried until a re-report matches them, the operator accepts them,
 * or the path becomes a readable file at head. A path that is not a file at head
 * is not evidence the code is gone (a directory can be renamed or re-rooted), so
 * it never resolves as `path-gone`; only a path absent from a readable commit does.
 */

import type { FindingSource } from "./lens-review-types.ts";
import type { ChangedRanges } from "./review-diff.ts";
import type { ResolveReason, StoredFinding } from "./review-findings-file.ts";
import type { HeadState } from "./review-findings-head.ts";
import { hashText, lineHashAt, snippetHashAt } from "./review-findings-match.ts";

/** What the rule decided for one untouched open row. */
export type RowFate = { kind: "resolve"; reason: ResolveReason } | { kind: "carry" };

/**
 * How a round reviewed the branch (computed once by the caller). Only `full`
 * may resolve a row.
 *   - `full`: a whole-branch review that reached a verdict;
 *   - `delta`: reviewed only `since..head`;
 *   - `incomplete`: a lens was blocked, so no verdict was reached.
 */
export type ReviewKind = "full" | "delta" | "incomplete";

const CARRY: RowFate = { kind: "carry" };

/**
 * The lens whose rows a DELTA round may not resolve by code-gone (step 9). A
 * security row's cited line is evidence of a risk, not of a fix: a delta sees
 * only its own changed lines, so its silence about the code is not enough to
 * retire the row. Such a row carries until a full review, as before.
 */
const SECURITY_LENS: FindingSource = "SECURITY";

/** The resolve reason a line-less row takes when a complete review no longer reports it (#1469). */
const NOT_REPORTED: RowFate = { kind: "resolve", reason: "not-reported" };

/** The snippet hash of a finding with no resolvable line. */
const NO_LINE_SNIPPET = snippetHashAt([], undefined);

/**
 * THE predicate for "an open, line-bearing CRITICAL that a complete full review
 * could retire" (#1832) — one definition for the two questions that must agree.
 *
 * The fate rule below (step 6) resolves such a row only on a complete full
 * review; the open-CRITICAL probe (review-findings-critical-probe.ts) asks
 * whether a row this predicate accepts is still on the branch, and answers "no
 * delta" when one is. When the two disagree the veto is either paid for nothing
 * (the probe forces a full round the fate rule would never retire anything in)
 * or lost (a row the rule resolves was never given the full round that resolving
 * requires). So neither side states the shape; both call this.
 *
 * The three conjuncts, each load-bearing:
 *   - `status === "open"` — an ACCEPTED row is suppressed by an operator decision
 *     and a round is FORBIDDEN to report it, so a full review proves nothing
 *     about it; a RESOLVED row is already retired.
 *   - `severity === "CRITICAL"` — only CRITICAL rows carry the never-resolve
 *     history this fix is about; a non-CRITICAL row retires on a delta.
 *   - `line !== undefined && lineHash !== undefined` — the fate rule resolves a
 *     CRITICAL only with its cited-line hash to compare (`rowFate` step 6/7),
 *     and a line-less CRITICAL retires as `not-reported` (#1469) on any complete
 *     full review, delta veto or not.
 */
export function isRetirableOpenCriticalRow(row: StoredFinding): boolean {
  return (
    row.status === "open" &&
    row.severity === "CRITICAL" &&
    row.line !== undefined &&
    row.lineHash !== undefined
  );
}

/** The head file's ±2-line window hashes and cited-line hashes, built once per lines array. */
interface HeadIndex {
  windows: ReadonlySet<string>;
  lineHashes: ReadonlySet<string>;
}
const indexCache = new WeakMap<readonly string[], HeadIndex>();

/** Window and line hashes of every line of a head file, as sets: one O(1) lookup per row. */
function indexOf(lines: readonly string[]): HeadIndex {
  const cached = indexCache.get(lines);
  if (cached) return cached;
  const windows = new Set<string>();
  const lineHashes = new Set<string>();
  for (let line = 1; line <= lines.length; line++) {
    windows.add(snippetHashAt(lines, line));
    const lh = lineHashAt(lines, line);
    if (lh !== undefined) lineHashes.add(lh);
  }
  const index = { windows, lineHashes };
  indexCache.set(lines, index);
  return index;
}

/** Extra evidence the rule needs beyond the row, the head state and the review kind. */
export interface FateContext {
  /**
   * The delta's changed line ranges (`changedLineRanges`), required when `review`
   * is `delta`: without it NOTHING resolves on a delta round, because the only
   * thing that separates a reviewed line from an unreviewed one is this map.
   */
  deltaRanges?: ChangedRanges;
}

/** Is `line` of `path` inside the delta's changed ranges? */
export function insideDelta(
  path: string,
  line: number,
  ranges: ChangedRanges | undefined,
): boolean {
  if (!ranges) return false;
  const spans = ranges.get(path);
  if (!spans) return false;
  return spans.some(([lo, hi]) => line >= lo && line <= hi);
}

/**
 * Would a finding on `line` of `f.path` fall OUTSIDE the delta's changed lines?
 *
 * The one predicate both halves of a round use: the suppression pass asks it of
 * the finding this round reported, and `rowFate` (step 8) asks it of the line an
 * untouched row was last observed at. A finding with no usable line is NOT
 * outside: with no line there is no claim about coverage to refute, so it falls
 * through to the ordinary rules rather than being suppressed by silence.
 */
export function outsideDelta(
  f: { path: string; line?: number },
  hasLine: boolean,
  ranges: ChangedRanges,
): boolean {
  if (!hasLine) return false;
  return !insideDelta(f.path, f.line ?? 0, ranges);
}

/** The resolve/carry decision for one untouched open row. */
export function rowFate(
  row: StoredFinding,
  head: HeadState,
  review: ReviewKind,
  ctx: FateContext = {},
): RowFate {
  const full = review === "full";
  switch (head.kind) {
    // An invalid path (unsafe spelling, or a directory/tree at head) has no
    // automatic exit at all — including #1469's: a path that cannot name a file
    // is not evidence the finding is gone, so the line-less rule never runs here.
    case "invalid":
      return linelessFate(review, { headInvalid: true, accepted: row.status === "accepted" });
    case "missing":
      return full ? { kind: "resolve", reason: "path-gone" } : CARRY;
    case "lines":
      return linesFate(row, head.lines, full, review, ctx.deltaRanges);
  }
}

/**
 * The fate of a row with no usable cited line (#1469).
 *
 * Such a row is a claim about the FILE, not about a line: it cites no code, so
 * none of the code-equality rules below can ever speak for it — they all key on
 * a snippet or a `lineHash` the row does not have. Carrying it forever was the
 * bug: the row blocked the verdict every round, the operator-facing acceptance
 * exit refuses every CRITICAL, and the only ways out were deleting the file or
 * hand-editing `.git/review-findings.json`.
 *
 * So the rule is the one piece of evidence a file-level claim answers to: a
 * COMPLETE full review of the branch that no longer reports it. The matching
 * half already happened in `applyFindingRound` — a row the round re-reported
 * (same lens, path and title, per `pickMatch`/`sameTitle`) was touched and never
 * reaches this function — so reaching here IS the round's silence.
 *
 * That silence counts only when the round actually reviewed everything, which is
 * why the gate is the caller's `review`, never an inferred "there was no delta":
 *   - `delta` carries: the round saw only its own changed ranges, so it never
 *     looked at the whole file and its silence says nothing;
 *   - `incomplete` carries: a blocked lens reached no verdict, which is the same
 *     absence of coverage under a different name.
 *
 * `headInvalid` carries for any review kind: a path that is unsafe, or a
 * directory rather than a file, is not evidence the code is gone (#1303), and
 * this rule must not become a second exit around that one.
 *
 * `accepted` carries for the same reason. An open row's silence-retirement is
 * sound because its next report re-matches it; an ACCEPTED row has no such
 * counterweight — the operator's decision suppresses it, so the round is
 * forbidden to report it, and a rule that retires rows on the round's silence
 * would lapse every file-level acceptance on the first full review that did not
 * mention it. The store's own rule for an accepted row is eviction on PROOF only
 * (its path absent from the reviewed commit), and "not re-reported" is precisely
 * the absence of evidence that rule refuses to act on.
 */
export function linelessFate(
  review: ReviewKind,
  opts: { headInvalid?: boolean; accepted?: boolean } = {},
): RowFate {
  if (opts.headInvalid || opts.accepted) return CARRY;
  return review === "full" ? NOT_REPORTED : CARRY;
}

/** The fate of a row whose path is a readable file at head. */
function linesFate(
  row: StoredFinding,
  lines: string[],
  full: boolean,
  review: ReviewKind,
  deltaRanges: ChangedRanges | undefined,
): RowFate {
  if (row.line === undefined || row.snippetHash === NO_LINE_SNIPPET) {
    return linelessFate(review, { accepted: row.status === "accepted" });
  }
  const index = indexOf(lines);
  if (index.windows.has(row.snippetHash)) return CARRY;
  if (row.lineHash !== undefined && index.lineHashes.has(row.lineHash)) return CARRY;
  if (row.line > lines.length) return full ? { kind: "resolve", reason: "line-past-eof" } : CARRY;
  // #1832 — a CRITICAL retires on evidence, but on the strongest evidence the
  // round can offer and nothing weaker: BOTH hashes absent (steps 3-4 already
  // carried anything that survives anywhere in the head file), the row not
  // re-reported (a re-report is matched in `applyFindingRound` and never comes
  // here), and a COMPLETE full review. A delta or an incomplete round saw too
  // little to retire a CRITICAL, and a CRITICAL with no `lineHash` has no proof
  // its cited line changed at all, so both cases carry. `lineHash` is already
  // known present here (an absent one returned at step 4's carry for a surviving
  // line, and the next line carries the rest), so what remains is the
  // full-review test; the row-shape half of that condition is the shared
  // `isRetirableOpenCriticalRow` the probe calls, so the two agree by
  // construction rather than by copy.
  if (row.severity === "CRITICAL") {
    return full && row.lineHash !== undefined ? { kind: "resolve", reason: "code-gone" } : CARRY;
  }
  if (row.lineHash === undefined) return CARRY;
  // Did this round review the stored line? A full review covers the whole
  // branch. A delta covers only its changed ranges, and the check is on the
  // STORED line: the caller's ranges are head-line numbers, and only the row's
  // own line says which head line it was last observed at. A security row is
  // never covered by a delta. An incomplete round is covered by neither branch,
  // so it carries: it reached no verdict to vouch for.
  const reviewed =
    full ||
    (review === "delta" &&
      row.lens.trim().toUpperCase() !== SECURITY_LENS &&
      insideDelta(row.path, row.line, deltaRanges));
  return reviewed ? { kind: "resolve", reason: "code-gone" } : CARRY;
}
