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
 *      → `carry`.
 *   3. The row's ±2-line window hash is found at ANY line of the head file →
 *      `carry`. Something near the cited code changed; the code did not.
 *   4. The row's cited-line hash (`lineHash`) is found at ANY line of the head
 *      file → `carry`. The cited line itself still exists, possibly moved.
 *   5. The cited line is past the end of the head file → `resolve("line-past-eof")`
 *      on a complete full review, else `carry`.
 *   6. A CRITICAL row is never resolved by a code change → `carry`.
 *   7. A row with no `lineHash` (written before the field existed) cannot prove
 *      its cited line changed → `carry`.
 *   8. The cited line itself is gone from the head file → `resolve("code-gone")`
 *      on a complete full review, else `carry`.
 *
 * The only resolving rule for a changed line is step 8: a row resolves when its
 * CITED LINE changed, never on a window edit alone. A trivial edit to a
 * neighbouring line (a comment inserted in the ±2 window) therefore cannot clear
 * a finding by omission.
 *
 * Trust assumption: step 8 resolves a non-CRITICAL row whose cited line changed
 * with no re-report. That is safe only because a complete full review re-reports
 * a finding that is still real — a lens that still sees the problem reports it
 * again and the row is matched, not resolved.
 *
 * Pure: the caller supplies the row, the head state and the review kind. A delta
 * or an incomplete review never resolves a row; it carries it.
 *
 * An invalid path (unsafe, or a directory/tree at head) has NO automatic exit:
 * its rows are carried until a re-report matches them, the operator accepts them,
 * or the path becomes a readable file at head. A path that is not a file at head
 * is not evidence the code is gone (a directory can be renamed or re-rooted), so
 * it never resolves as `path-gone`; only a path absent from a readable commit does.
 */

import type { ResolveReason, StoredFinding } from "./review-findings-file.ts";
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

/**
 * The head state a row's cited code is judged against. Tagged so each case is
 * handled by name: `missing` is absent from a readable commit, `invalid` cannot
 * name a file at head (unsafe, or a directory), `lines` is a readable blob.
 */
export type HeadState =
  | { kind: "lines"; lines: string[] }
  | { kind: "missing" }
  | { kind: "invalid" };

const CARRY: RowFate = { kind: "carry" };

/** The snippet hash of a finding with no resolvable line. */
const NO_LINE_SNIPPET = snippetHashAt([], undefined);

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

/** The resolve/carry decision for one untouched open row. */
export function rowFate(row: StoredFinding, head: HeadState, review: ReviewKind): RowFate {
  const full = review === "full";
  switch (head.kind) {
    case "invalid":
      return CARRY;
    case "missing":
      return full ? { kind: "resolve", reason: "path-gone" } : CARRY;
    case "lines":
      return linesFate(row, head.lines, full);
  }
}

/** The fate of a row whose path is a readable file at head. */
function linesFate(row: StoredFinding, lines: string[], full: boolean): RowFate {
  if (row.line === undefined || row.snippetHash === NO_LINE_SNIPPET) return CARRY;
  const index = indexOf(lines);
  if (index.windows.has(row.snippetHash)) return CARRY;
  if (row.lineHash !== undefined && index.lineHashes.has(row.lineHash)) return CARRY;
  if (row.line > lines.length) return full ? { kind: "resolve", reason: "line-past-eof" } : CARRY;
  if (row.severity === "CRITICAL" || row.lineHash === undefined) return CARRY;
  return full ? { kind: "resolve", reason: "code-gone" } : CARRY;
}
