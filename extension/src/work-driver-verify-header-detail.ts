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
 * `work-driver-verify-credential-screen.ts` — the tally's three-arm veto and the
 * post-redaction opaque-run arm that catches an unprefixed base64 blob. It lives
 * there so the record and the harvest each import ONE secret module: the harvest
 * asks the classifier (which carries the marker/echo/keyword-credential veto
 * through `extractSpecificAssertion`) plus that screen, and a detail that still
 * carries a long base64-shaped run after redaction is refused outright — which is
 * the arm that catches the unprefixed PEM body, the bare `Authorization: Basic …`
 * and the `ssh-rsa AAAA…` blob no keyword pattern anchors on (#1841 round 2).
 *
 * The bounds it obeys:
 *
 *   - **Indentation is measured BEFORE trimming**, the same rule the tally harvest
 *     uses: "deeper than the header" is a fact about the raw line, and a reader that
 *     trims first would harvest the whole stream.
 *   - **The walk stops at the first line that is not deeper**, at the harness's own
 *     wrapper sentence (#1810 — the harvest is never handed raw record text, and
 *     never harvests through the harness's writing either), at the first line the
 *     shared table claims as a failure or as a passing line, or at the first
 *     credential-shaped line (see below). So the `ok`/`skip` block that
 *     follows the details contributes nothing, and a second `FAIL` header starts
 *     its own block instead of extending this one.
 *   - **Every judge is asked inside the classifier's own scan window**
 *     ({@link FAILURE_LINE_SCAN_MAX}): a gate that prints a 100 KB blob under one
 *     header must not be classified whole. The credential screen
 *     (`detailLooksCredential`, from `work-driver-verify-credential-screen.ts`) is
 *     asked on the same bounded view, and the classifier is asked first because it
 *     carries the keyword/echo/marker veto (`isNonAssertionLine` inside
 *     `extractSpecificAssertion`) — #1841 round 2: an unprefixed PEM body, a bare
 *     `Authorization: Basic …` or an `ssh-rsa AAAA…` blob printed under a header
 *     reached the developer prompt, the `corrective-round` event and the write-fence
 *     admission evidence, while the very same line unindented is refused today.
 *     So the walk stops rather than dropping one line silently: dropping is
 *     what let the line next to a refused one through, and the whole block under such
 *     a line is a dump, not a diagnosis.
 *   - **At most {@link HEADER_DETAIL_MAX} lines, gathered from at most
 *     {@link HEADER_DETAIL_SCAN_MAX} candidate lines,** with no clip of its own
 *     (see {@link HEADER_DETAIL_LINE_MAX}: a line that long is refused, not cut).
 *     A gate can print an entire file as a diff under one header; the corrective
 *     round gives the developer at most `CORRECTIVE_MAX_LINES` lines anyway, and
 *     the record's `redactThenBound` and the decision's `CORRECTIVE_LINE_MAX` are
 *     the two bounds that cut what survives.
 */

import { detailLooksCredential } from "./work-driver-verify-credential-screen.ts";
import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine,
  isHarnessWrapper,
  isSuccessLine,
} from "./work-driver-verify-failures.ts";
import { isFailHeaderLine } from "./work-driver-verify-shapes.ts";
import { splitLines } from "./work-driver-verify-support.ts";

/**
 * The most detail lines one header contributes to the evidence. Exported so the
 * suite can assert it never exceeds the corrective round's own line cap (#1841);
 * the owner of that cap is `CORRECTIVE_MAX_LINES`, and this is deliberately equal
 * to it so the harvest never builds evidence the reader is certain to slice away.
 */
export const HEADER_DETAIL_MAX = 6;

/** The most candidate lines one header walks, whatever it prints beneath itself. */
export const HEADER_DETAIL_SCAN_MAX = 50;

/**
 * The longest one detail line is kept at. The harvest clips NOTHING itself
 * (#1841 round 3, d — one owner per bound): the two clips that apply to a detail
 * are the record's `redactThenBound` at `ASSERTION_LINE_MAX` and the corrective
 * round's `CORRECTIVE_LINE_MAX`, in that order, and a private third slice here
 * would be a bound the developer's line is not actually cut at. The name stays and
 * the walk below still refuses such a line, because the shape it describes is the
 * reason the walk is bounded at all: a gate can print an entire file as a diff
 * under one header, and a line that long is a dump, not a reason — its first
 * {@link FAILURE_LINE_SCAN_MAX} are all any judge can read anyway.
 */
const HEADER_DETAIL_LINE_MAX = 300;

/** Leading-whitespace width of a raw line (the indentation, measured untrimmed). */
function indentOf(raw: string): number {
  let n = 0;
  while (n < raw.length && (raw[n] === " " || raw[n] === "\t")) n++;
  return n;
}

/**
 * The indented detail lines of every `FAIL` header in one stream — the lines that
 * name nothing on their own and would otherwise be dropped. What already names
 * something is NOT this reader's business: the record's per-line walk keeps those.
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
    if (!isFailHeaderLine(header)) continue;
    let taken = 0;
    for (let k = i + 1; k < lines.length && taken < HEADER_DETAIL_MAX; k++) {
      if (k - i > HEADER_DETAIL_SCAN_MAX) break;
      const candidate = lines[k] ?? "";
      if (indentOf(candidate) <= indentOf(header)) break;
      // The harness's own sentence is not a gate's prose beneath a header — it is
      // what the #1810 guard exists for, and the harvest must never be handed it.
      if (isHarnessWrapper(candidate)) break;
      const detail = candidate.trim();
      if (detail.length === 0) break;
      // The classifier's own scan window is the bound on what every judge below is
      // ASKED: a gate that prints a 100 KB blob under a header must not be
      // classified whole.
      const asked =
        detail.length > FAILURE_LINE_SCAN_MAX ? detail.slice(0, FAILURE_LINE_SCAN_MAX) : detail;
      // A line the table claims — a real failure line or a passing one — is not
      // this header's prose: the first is evidence in its own right and the second
      // (`ok`, `skip`, a timing block) is the next block. So a credential line the
      // classifier refuses (a marker, an echoed `$ `, a keyword-shaped credential)
      // stops the walk here, and the screen below catches the shapes it does not
      // name — an unprefixed base64 blob, which is neither a failure nor a pass and
      // would otherwise have been kept as prose.
      if (classifyFailureLine(asked) !== undefined) break;
      if (isSuccessLine(asked)) break;
      // The credential screen, asked on the same bounded view the classifier saw.
      if (detailLooksCredential(asked)) break;
      // A line past the dump threshold is not a reason: the walk stops rather than
      // clipping one, so no bound this module owns can disagree with the record's
      // and the decision's (see {@link HEADER_DETAIL_LINE_MAX}).
      if (detail.length > HEADER_DETAIL_LINE_MAX) break;
      out.push(detail);
      taken++;
    }
  }
  return out;
}
