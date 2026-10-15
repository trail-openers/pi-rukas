/**
 * review-findings-fate — the ONE resolve/carry rule for an untouched open
 * findings row (#1125 first slice, #1130). The store (review-findings-store.ts)
 * calls `rowFate` for every open row the round did not match; nothing else
 * decides a row's fate.
 *
 * Decision order, first match wins:
 *   1. The row's path is absent at head → `resolve("path-gone")` on a complete
 *      full review, else `omit`.
 *   2. No usable line (no stored line, the empty-snippet hash, or no head lines)
 *      → `carry`. A no-line row is carried while its path is present.
 *   3. The row's ±2-line window hash is found at ANY line of the head file →
 *      `carry`. This wins over step 4: a row cited past EOF whose code moved up
 *      (40 lines deleted above it) still stands.
 *   4. The cited line is past the end of the head file → `resolve("line-past-eof")`
 *      on a complete full review, else `omit`.
 *   5. The window hash is nowhere in the head file (the cited code changed) →
 *      `resolve("code-gone")` on a complete full review, else `carry`. A
 *      CRITICAL row is never resolved by this step: it is carried.
 *
 * Trust assumption: step 5 resolves a non-CRITICAL row on a window change alone.
 * That is safe only because a complete full review re-reports a finding that is
 * still real — a lens that still sees the problem reports it again and the row is
 * matched, not resolved. CRITICAL rows are excluded from step 5 so a trivial edit
 * inside the ±2 window cannot silently clear a CRITICAL.
 *
 * Pure: the caller supplies the row, the head state and the review kind. A delta
 * or an incomplete review never resolves a row.
 */

import type { ResolveReason, StoredFinding } from "./review-findings-file.ts";
import { snippetHashAt } from "./review-findings-match.ts";

/** What the rule decided for one untouched open row. */
export type RowFate =
  | { kind: "resolve"; reason: ResolveReason }
  | { kind: "carry" }
  | { kind: "omit" };

/** How this round reviewed the branch. Only `full` may resolve a row. */
export type ReviewKind = "full" | "delta" | "incomplete";

/** The head state a row's cited code is judged against. */
export interface HeadState {
  /** The row's path is absent at head. */
  pathGone: boolean;
  /** The head file's lines; undefined when the path is absent. */
  lines?: readonly string[];
}

const CARRY: RowFate = { kind: "carry" };
const OMIT: RowFate = { kind: "omit" };

/** The snippet hash of a finding with no resolvable line. */
const NO_LINE_SNIPPET = snippetHashAt([], undefined);

/** Window hashes of each head file, built once per lines array (the caller reuses it per path). */
const windowCache = new WeakMap<readonly string[], ReadonlySet<string>>();

/** Every ±2-line window hash of a head file, as a set: one O(1) lookup per row. */
function windowHashesOf(lines: readonly string[]): ReadonlySet<string> {
  const cached = windowCache.get(lines);
  if (cached) return cached;
  const hashes = new Set<string>();
  for (let line = 1; line <= lines.length; line++) hashes.add(snippetHashAt(lines, line));
  windowCache.set(lines, hashes);
  return hashes;
}

/** The resolve/carry/omit decision for one untouched open row. */
export function rowFate(row: StoredFinding, head: HeadState, review: ReviewKind): RowFate {
  const full = review === "full";
  if (head.pathGone) return full ? { kind: "resolve", reason: "path-gone" } : OMIT;
  const lines = head.lines;
  if (!lines || row.line === undefined || row.snippetHash === NO_LINE_SNIPPET) return CARRY;
  if (windowHashesOf(lines).has(row.snippetHash)) return CARRY;
  if (row.line > lines.length) return full ? { kind: "resolve", reason: "line-past-eof" } : OMIT;
  if (row.severity === "CRITICAL") return CARRY;
  return full ? { kind: "resolve", reason: "code-gone" } : CARRY;
}
