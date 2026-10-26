/**
 * work-driver-verify-header-detail — #1841: the indented detail lines a
 * `FAIL  <description>` header prints beneath itself, as corrective-round evidence.
 *
 * The defect. A project gate reports a failing check as a header plus prose:
 *
 *     FAIL  the shell line budget (scripts/budget.max)
 *           check-lines: 24639 lines, over the ceiling of 24576.
 *           Take out 63 lines.
 *     ok    shellcheck and the shell tests of the change
 *
 * The table now classifies the header (`fail-header`, #1841), so a corrective round
 * is earned — but the header alone tells the developer WHICH check went red, not
 * what to change. The three indented lines that say so named nothing, classified
 * as nothing, and were dropped, so the developer was dispatched to re-run the verify
 * and rediscover the ceiling by hand. {@link harvestHeaderDetails} is the small
 * reader that carries them, on BOTH routes.
 *
 * Why this is its own module, and not a flag on the tally harvest next door.
 * `harvestConsolidatedTallies` (`work-driver-verify-tally.ts`) is deliberately
 * CONSOLIDATED-ONLY — its own docblock explains why harvesting a per-worktree
 * stream turned the harness sentence into a second evidence line — and its lines
 * are JOINED names bounded by `TALLY_LINE_MAX`/`TALLY_JOIN_MAX`. This harvest is the
 * opposite shape on both counts: it runs on the per-worktree route too, and it keeps
 * each detail line as its OWN evidence line so the sentence the gate printed stays
 * readable. Sharing the module would have meant one file with two routes and two
 * bound sets in it, which is exactly the confusion its own docblock warns about.
 *
 * The three bounds it obeys, all stated in {@link HEADER_DETAIL_MAX} /
 * {@link HEADER_DETAIL_LINE_MAX}:
 *
 *   - **Indentation is measured BEFORE trimming**, the same rule the tally harvest
 *     uses: "deeper than the header" is a fact about the raw line, and a reader that
 *     trims first would harvest the whole stream.
 *   - **The walk stops at the first line that is not deeper**, or that the shared
 *     table claims as a failure or as a passing line. So the `ok`/`skip` block that
 *     follows the details contributes nothing, and a second `FAIL` header starts its
 *     own block instead of extending this one.
 *   - **At most {@link HEADER_DETAIL_MAX} lines, each cut at
 *     {@link HEADER_DETAIL_LINE_MAX}.** A gate can print an entire file as a diff
 *     under one header; the corrective round gives the developer at most
 *     `CORRECTIVE_MAX_LINES` lines anyway, and the record's own `push` redacts and
 *     clips the whole line again on the way out.
 */

import { classifyFailureLine, isSuccessLine } from "./work-driver-verify-failures.ts";
import { splitLines } from "./work-driver-verify-support.ts";

/** A `FAIL  <description>` header: the status token, then a non-space description. */
const FAIL_HEADER_RE = /^\s*FAIL\s+\S/;

/** The most detail lines one header contributes to the evidence. */
const HEADER_DETAIL_MAX = 6;

/** The longest one detail line is kept at — a longer one is a dump, not a reason. */
const HEADER_DETAIL_LINE_MAX = 300;

/** Leading-whitespace width of a raw line (the indentation, measured untrimmed). */
function indentOf(raw: string): number {
  let n = 0;
  while (n < raw.length && (raw[n] === " " || raw[n] === "\t")) n++;
  return n;
}

/**
 * The evidence lines of one stream: every line that already names something, plus
 * the indented details of every `FAIL` header — which name nothing on their own and
 * would otherwise be dropped.
 *
 * The caller hands this its OWN UNWRAPPED view of the stream (the per-worktree
 * reader passes the text with each harness wrapper replaced by what
 * `harnessInnerLine` reports behind it), never the raw record text: a header that
 * sits inside `verify command \`cmd\` failed in <cwd>: …` would otherwise be measured
 * against harness prose and harvested from it, which is the #1810 defect.
 *
 * @param view the gate's stream, read line by line with the indentation intact
 * @returns the header's detail lines, in stream order, trimmed — `[]` when the
 *   stream holds no `FAIL` header with deeper lines beneath it
 */
export function harvestHeaderDetails(view: string): string[] {
  const lines = splitLines(view);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i] ?? "";
    if (!FAIL_HEADER_RE.test(header)) continue;
    let taken = 0;
    for (let k = i + 1; k < lines.length && taken < HEADER_DETAIL_MAX; k++) {
      const candidate = lines[k] ?? "";
      if (indentOf(candidate) <= indentOf(header)) break;
      const detail = candidate.trim();
      if (detail.length === 0) break;
      // A line the table claims — a real failure line or a passing one — is not
      // this header's prose: the first is evidence in its own right and the second
      // (`ok`, `skip`, a timing block) is the next block. Either way the walk stops.
      if (classifyFailureLine(detail) !== undefined) break;
      if (isSuccessLine(detail)) break;
      out.push(
        detail.length > HEADER_DETAIL_LINE_MAX ? detail.slice(0, HEADER_DETAIL_LINE_MAX) : detail,
      );
      taken++;
    }
  }
  return out;
}
