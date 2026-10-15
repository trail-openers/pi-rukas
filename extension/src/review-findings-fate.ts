/**
 * review-findings-fate — the ONE resolve/carry rule for an untouched open
 * findings row (#1125 first slice, #1130).
 *
 * A row the current round did not match is decided here and nowhere else:
 *   - `resolve`: a complete full review no longer reports it and its cited code
 *     is gone — the path is absent at head, the cited line is past the end of
 *     the head file, or the row's ±2-line snippet (its stored snippetHash) no
 *     longer appears at ANY line of the head file. An edit to the cited code
 *     therefore resolves the row; an insertion above it does not (the window
 *     moves, but the hash is still findable).
 *   - `carry`: the cited code still stands; the row is reported with its stored
 *     title. A no-line row (no stored line, or the empty-snippet hash) is always
 *     carried by this rule.
 *   - `omit`: the cited code is gone but the review is not complete, so nothing
 *     resolves and the row is not carried either (the pre-existing behaviour).
 *
 * Pure: the caller supplies the head lines and whether the review is complete
 * AND full. A delta or an incomplete review never resolves a row.
 */

import type { StoredFinding } from "./review-findings-file.ts";
import { snippetHashAt } from "./review-findings-match.ts";

export type RowFate = "resolve" | "carry" | "omit";

/** The head state a row's cited code is judged against. */
export interface HeadState {
  /** The row's path is absent at head. */
  pathGone: boolean;
  /** The head file's lines; undefined when the path is absent. */
  lines?: readonly string[];
}

/** The snippet hash of a finding with no resolvable line. */
const NO_LINE_SNIPPET = snippetHashAt([], undefined);

/** Does a ±2-line window with this hash exist at any line of the head file? */
function snippetAtHead(lines: readonly string[], hash: string): boolean {
  for (let line = 1; line <= lines.length; line++) {
    if (snippetHashAt(lines, line) === hash) return true;
  }
  return false;
}

/** The resolve/carry decision for one untouched open row. */
export function rowFate(row: StoredFinding, head: HeadState, complete: boolean): RowFate {
  const truncated = !!head.lines && row.line !== undefined && row.line > head.lines.length;
  if (head.pathGone || truncated) return complete ? "resolve" : "omit";
  if (!complete || !head.lines || row.line === undefined) return "carry";
  if (row.snippetHash === NO_LINE_SNIPPET) return "carry";
  return snippetAtHead(head.lines, row.snippetHash) ? "carry" : "resolve";
}
