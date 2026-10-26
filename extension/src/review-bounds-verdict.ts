/**
 * review-bounds-verdict — reading a reviewer's FINAL verdict out of one
 * assistant message (#1827).
 *
 * The live post-verdict stop in `review-bounds.ts` decides whether a reviewer
 * child has finished. Its first version asked the consumer's own reader
 * (`readEnumMarker`) whether a verdict appeared anywhere in the last eight text
 * blocks of the accumulation. That is the same function `parseVerdict` runs,
 * which was taken as proof the two could not disagree — but "anywhere in the
 * window" is a much looser question than "is this the reply's verdict", and the
 * adversarial review reproduced two ways to exploit it:
 *
 *   - The reviewer's brief (`buildAdversarialPrompt`) hands the model a
 *     four-line menu of every value, and `readEnumMarker` takes the LAST match
 *     in the text. A child that echoes the menu, or quotes one example line in
 *     a code fence, early in its reply was ended at that turn with a verdict it
 *     never issued, and the review was never performed.
 *   - The window spanned messages, so a marker from an earlier turn sat in the
 *     scan of a later one, and a turn that added no text could still "find" it.
 *
 * The rule this module owns is the narrow one: a verdict counts only when the
 * message that ENDS the reviewer carries no tool calls and its LAST non-empty
 * text block states exactly one distinct verdict, outside any fenced block.
 * Anything else — a menu (four values), a quoted example, a verdict buried in
 * a code sample, a verdict typed between tool calls — is not an ending.
 *
 * The values the live stop will accept, in the canonical spelling `parseVerdict`
 * returns them (`VERDICT_STATUSES` is the enum it reads): `CRITICAL_ISSUES_FOUND`,
 * `ISSUES_FOUND`, `MINOR_OBSERVATIONS`, `APPROVED`.
 */

import { VERDICT_STATUSES } from "./adversarial-verdict.ts";
import { adapterFor } from "./model-adapters.ts";
import type { PiMessage } from "./pi-event-shapes.ts";
import { readEnumMarker } from "./reply-markers.ts";

/** A verdict status in its canonical spelling. The one spelling `parseVerdict`
 *  returns, and the type `VerdictStop.status()` and `ReviewBoundOutcome.verdictStatus`
 *  are both declared as — a `string` there lets a caller compare against a typo
 *  the compiler would not see. */
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

/**
 * The character budget for the stop's accumulation (#1827 round 4).
 *
 * The accumulation is the RESULT the spawn reports when the stop fires, so it
 * keeps collecting whatever the caps say — which makes it unbounded memory on a
 * child measured at 476 turns and 80M tokens of output. Past this budget the
 * accumulator stops appending and keeps the HEAD: the head is where a reviewer's
 * findings sit, and the closing verdict line is preserved separately by the
 * stop itself (`status()`), so a truncated reply still reports the verdict that
 * ended the child.
 */
export const VERDICT_ACCUMULATION_BUDGET = 256 * 1024;

/**
 * Append one text block to an accumulation, never past the budget.
 *
 * The block that crosses the budget is cut rather than dropped, so a reviewer
 * that ends on one enormous block still contributes its opening. Exported for
 * the accumulator in `review-bounds.ts` and for the test that feeds it an
 * oversized stream; the budget rule has exactly one implementation.
 */
export function appendBounded(parts: string[], text: string): void {
  let used = 0;
  for (const part of parts) used += part.length + 2; // the "\n" join
  const room = VERDICT_ACCUMULATION_BUDGET - used;
  if (room <= 0) return;
  if (text.length > room) parts.push(text.slice(0, room));
  else parts.push(text);
}

/**
 * The model-adapter text filter `collapseEvents` applies (spawn-collapse-events.ts
 * / model-adapters.ts), reused rather than re-implemented (#1827 round 4).
 *
 * The stop's accumulation becomes `result.text` outright when it fires, so
 * without this a GLM `{type:"text",text:"None"}` block — a Python-repr artifact
 * the collapse drops — would reach the loop's `parseVerdict` through the frozen
 * reply. Shared rather than copied so the two paths cannot drift: an adapter
 * added to the registry filters both at once.
 */
export function keepVerdictText(msg: PiMessage, text: string): boolean {
  const adapter = adapterFor(msg.model, msg.provider);
  return adapter.isArtifactText?.(text) !== true;
}

/** Lines opening or closing a fenced block. Built once, not per call: this
 *  sits on the per-stdout-line hot path of a child that may run 400+ turns. */
const FENCE_LINE_RE = /^\s*(```|~~~)/;
/** The heading spelling of the marker (`### VERDICT`), whose value sits on the
 *  next non-empty line and so answers to no line-level read on its own. */
const VERDICT_HEADING_RE = /^\s*#{1,6}\s*\**\s*VERDICT\s*\**\s*$/;

/** `\bSTATUS\b` (case-insensitive) per verdict value, compiled once at module
 *  load: the previous version rebuilt all four per candidate line of every
 *  assistant message of a child that may run 400+ turns. */
const VERDICT_WORD_RES: readonly RegExp[] = VERDICT_STATUSES.map(
  (status) => new RegExp(`\\b${status}\\b`, "i"),
);

/**
 * How many ```/~~~ lines a block may contain before it is treated as fenced
 * prose rather than the reviewer's own closing line. One balanced fence is
 * ordinary (a reviewer quoting the line it objects to, then concluding); a
 * block with more than that is a report full of code samples, and a marker
 * anywhere in it is quotation until proven otherwise.
 */
const MAX_FENCE_LINES = 2;

/**
 * Where a line sits relative to the fences that precede it. `outside` is the
 * only spelling a stop accepts. `inside` is a quotation. `unknown` is a block
 * whose fence accounting we cannot trust (more than `MAX_FENCE_LINES` fence
 * markers) — a shape we cannot read is not evidence the model meant the marker,
 * so it stops nothing.
 */
type FencePosition = "outside" | "inside" | "unknown";

/** All four values, in a `readEnumMarker`-shaped line each — the reviewer's own
 *  brief (`buildAdversarialPrompts`) hands the model exactly this list. */
const VERDICT_MENU_LINES = VERDICT_STATUSES.map((status) => `VERDICT: ${status}`);
/** Each menu line with all whitespace collapsed, for comparison against a line
 *  that differs from it only in indentation or padding. */
const VERDICT_MENU_COMPACT = VERDICT_MENU_LINES.map((line) => line.replace(/\s+/g, " ").trim());

/** A marker line the model is SHOWING rather than signing — the protocol read
 *  back, where a reader over the whole text would find a value in it. Three
 *  shapes, each reproduced by the adversarial review of #1827:
 *
 *   - an echo of one of the brief's menu lines (`VERDICT: APPROVED` with nothing
 *     else on the line) — the reviewer reciting the list it was handed;
 *   - a TEMPLATE with a placeholder value (`VERDICT: <APPROVED|ISSUES_FOUND|…>`),
 *     the shape a brief uses to introduce the menu, from which a reader takes the
 *     first value inside the angle brackets;
 *   - a marker quoted INSIDE a sentence (`For example: **VERDICT: APPROVED**`).
 *     A line the reviewer signs is the marker and nothing but it — the marker
 *     alone, or the marker wrapped in emphasis (`**VERDICT: APPROVED**`), which is
 *     the spelling the tolerant reader was widened for in #408. Anything else on
 *     the line is the reviewer talking ABOUT the protocol.
 *
 * Two boundaries keep this a narrowing rather than a veto, and both are facts
 * about how the marker is SIGNED rather than about where the line sits:
 *
 *   - the HEADING form is exempt. `### VERDICT` signs nothing on its own line —
 *     its value is on the line below — so a "nothing else on the line" test would
 *     reject a form `readEnumMarker` accepts;
 *   - the block's LAST marker line is exempt, and that exemption is what keeps a
 *     real verdict stopping: the brief's own instructions, and the reviewer's own
 *     summary, are byte-identical to a menu line (`VERDICT: APPROVED`), so any
 *     test that refused menu-shaped lines outright would stand down every genuine
 *     ending. Only the line the message ENDS on is trusted on structure alone;
 *     every marker line above it is judged on its shape, and an echo or quotation
 *     up there adds a SECOND distinct verdict to the count, which is what refuses
 *     the block.
 *
 * That pairing is what the adversarial review of #1827 needed and the old word
 * count could not give: a block that echoes the brief's menu, or quotes an example
 * line, above a real closing line names two or more distinct verdicts and is
 * refused — while the ordinary `prose … VERDICT: X … prose` ending, whose only
 * marker line is the one it signs, still stops.
 *
 * Menu-echo comparison is against the WHOLE line, never `includes`:
 * `VERDICT: APPROVED and the gates pass` is the reviewer's own sentence.
 */
function shownNotChosen(line: string): boolean {
  if (VERDICT_HEADING_RE.test(line)) return false; // heading form signs elsewhere
  const compact = line.replace(/\s+/g, " ").trim();
  if (VERDICT_MENU_COMPACT.includes(compact)) return true;
  // A template: VERDICT followed (past any emphasis/colon) by `<`…`>`.
  if (/\**\s*VERDICT\s*\**\s*:?\s*<?[^>\n]*>[^\n]*$/i.test(compact)) return true;
  // A quotation: only emphasis and whitespace may sit in front of the marker.
  return !/^[*_\-\s]*\**\s*VERDICT\b/i.test(compact);
}

/** How many fence markers sit above line index `at` in `block`? Used for the one
 *  case the line-level reader cannot judge on its own — a heading whose value is
 *  the line below it. */
function countFencesBefore(block: string, at: number): number {
  let fences = 0;
  const lines = block.split("\n");
  for (let i = 0; i < at && i < lines.length; i++) {
    if (isFenceLine(lines[i] as string)) fences += 1;
  }
  return fences;
}

function fencePositionOf(line: string, fencesBefore: number): FencePosition {
  if (isFenceLine(line)) return "inside";
  if (fencesBefore > MAX_FENCE_LINES) return "unknown";
  return fencesBefore % 2 === 0 ? "outside" : "inside";
}

/** Does this line open or close a fenced block? */
function isFenceLine(line: string): boolean {
  return FENCE_LINE_RE.test(line);
}

/** The non-empty text blocks of a message, in stream order. */
function textBlocksOf(msg: PiMessage): string[] {
  const out: string[] = [];
  for (const block of msg.content ?? []) {
    if (block.type === "text" && block.text) out.push(block.text);
  }
  return out;
}

/**
 * The marker-shaped lines of a block that sit OUTSIDE every fence: the lines a
 * `readEnumMarker(…, "VERDICT", …)` read answers to, and the only lines the
 * distinct-verdict count is taken from.
 *
 * The previous rule counted every occurrence of a status WORD anywhere in the
 * block, so the stop's behaviour depended on how the reviewer phrased its
 * reasoning rather than on what it closed with — and the reviewer's brief hands
 * it all four values as a menu, so prose that names two of them is ordinary
 * argument, not a refusal to choose. A menu, an echoed template or a fenced
 * example still produces two or four distinct marker lines and stops nothing.
 */
function markerLines(block: string): string[] {
  const out: string[] = [];
  const lines = block.split("\n");
  let fences = 0;
  for (const line of lines) {
    if (isFenceLine(line)) {
      fences += 1;
      continue;
    }
    // Fence parity decides, and nothing else: an odd number of fence markers
    // above a line puts it inside a block, where a `VERDICT:` is an example the
    // reviewer pasted, not a verdict it signed. More than `MAX_FENCE_LINES`
    // markers and the accounting cannot be trusted at all, so the block yields no
    // candidate lines and stops nothing (a shape we cannot read is never evidence).
    if (fences > MAX_FENCE_LINES) return [];
    if (fences % 2 !== 0) continue;
    if (readEnumMarker(line, "VERDICT", VERDICT_STATUSES) || VERDICT_HEADING_RE.test(line)) {
      out.push(line);
    }
  }
  return out;
}

/** Does this line present MORE THAN ONE of the four verdicts inside marker syntax
 *  — i.e. is it a menu/template (`VERDICT: <APPROVED|ISSUES_FOUND|…>`, or
 *  `VERDICT: APPROVED|ISSUES_FOUND`) rather than a signed verdict? Both words must
 *  appear on the same line AND that line must carry marker syntax, so ordinary
 *  prose that argues about two verdicts is not this shape. */
function namesMultipleVerdicts(line: string): boolean {
  if (!VERDICT_MARKER_RE.test(line)) return false;
  let named = 0;
  for (const re of VERDICT_WORD_RES) {
    re.lastIndex = 0;
    if (re.test(line)) named += 1;
  }
  return named > 1;
}

/** A line of the form `VERDICT:` (past any emphasis) followed by something: the
 *  marker syntax, in any spelling the reader accepts or not. Distinguishes a line
 *  that PRESENTS a verdict from prose that merely names one. */
const VERDICT_MARKER_RE = /\**\s*VERDICT\s*\**\s*:?\s*\S/i;

/**
 * Does this block REPEAT the protocol rather than sign a verdict? #1827 round 4.
 *
 * The two shapes the old whole-block word count got wrong in OPPOSITE directions:
 *
 *   - a block that reprints the brief's four-line menu, quotes an example line, or
 *     carries a placeholder template (`VERDICT: <APPROVED|ISSUES_FOUND|…>`) is the
 *     protocol being read back, and must end nothing — even though it ends on a
 *     line a marker reader accepts;
 *   - a block that merely ARGUES about the verdicts in prose and then signs one
 *     ("This is ISSUES_FOUND rather than CRITICAL_ISSUES_FOUND because…\n\nVERDICT:
 *     ISSUES_FOUND") is a review that finished, and must still stop.
 *
 * What separates them is the MARKER SYNTAX, not the words: a line of the form
 * `VERDICT:` (past any emphasis) immediately followed by one of the four enum
 * values, or the reader's own heading form, is a line the reviewer writes only
 * when it is presenting a verdict. Prose that names the values inside a sentence
 * is not that shape, so arguing about two verdicts costs the reviewer nothing.
 * The reviewer's own closing line is the LAST such line in the block; anything of
 * that shape above it is a recitation, and the block is refused. A heading is
 * exempt from the recitation test when it pairs with the closing line (heading +
 * its value = one verdict), which is the form `readEnumMarker` accepts.
 */
function blockRefusesVerdict(block: string): boolean {
  const lines = block.split("\n");
  // A placeholder TEMPLATE (`VERDICT: <APPROVED|ISSUES_FOUND|…>`) is the brief's
  // own way of INTRODUCING the menu: a line that names more than one of the four
  // values is the reviewer listing the choices, never a verdict it signed, so a
  // block that carries one is refused outright. Prose that names one value in a
  // sentence is not this shape — it has no `VERDICT:` marker syntax at all — which
  // is what keeps "this is ISSUES_FOUND rather than CRITICAL_ISSUES_FOUND because…
  // VERDICT: ISSUES_FOUND" stopping.
  for (const line of lines) {
    if (namesMultipleVerdicts(line)) return true;
  }
  const markerIdx: number[] = [];
  let lastValueIdx = -1;
  lines.forEach((line, i) => {
    const value = readEnumMarker(line, "VERDICT", VERDICT_STATUSES);
    if (value === undefined && !VERDICT_HEADING_RE.test(line)) return;
    markerIdx.push(i);
    if (value !== undefined) lastValueIdx = i;
  });
  if (markerIdx.length === 0) return false;
  if (lastValueIdx === -1) {
    // A block of headings only: `### VERDICT` plus bare value lines, no inline
    // `VERDICT: X` anywhere. Two such headings are two verdicts offered; one is
    // the reader's own heading form, which the caller judges on its two lines.
    return markerIdx.length > 1;
  }
  // A heading with any value-bearing marker line after it is the protocol laid
  // out and then picked from, not a verdict signed.
  if (markerIdx[markerIdx.length - 1] !== lastValueIdx) return true;
  for (const i of markerIdx) {
    if (i === lastValueIdx) continue;
    // A heading is a recitation only when it is followed by ANOTHER marker-shaped
    // line (`### VERDICT` then `VERDICT: ISSUES_FOUND` = the menu laid out and
    // picked from). A heading whose next non-empty line is a bare verdict word is
    // the reader's own heading form, and is legitimate wherever it sits: the
    // closing-line search below is what decides whether it ends the message, on
    // exact agreement with the single verdict the candidate lines named.
    if (VERDICT_HEADING_RE.test(lines[i] as string)) {
      const nextMarker = markerIdx.find((j) => j > i);
      if (nextMarker === undefined || nextMarker === lastValueIdx) continue;
    }
    return true;
  }
  return false;
}

/**
 * The verdict an assistant message ENDS on, or undefined for "keep going".
 *
 * Four refusals, each one a shape reproduced by the adversarial review of
 * #1827 as a fabricated end-of-review:
 *
 *   1. the message made tool calls — a turn that calls a tool is still at
 *      work, and a verdict typed alongside a `bash` call is a plan, not an
 *      ending;
 *   2. the marker is not in the LAST non-empty text block — everything above
 *      it is the reasoning that led to the closing line, and a verdict in it
 *      is a rehearsal;
 *   3. the block's unfenced marker lines name more than one distinct verdict —
 *      the reviewer's own prompt (`buildAdversarialPrompt`) hands the model a
 *      menu of all four, so a reply that echoes the menu, or quotes two example
 *      lines to compare them, is reciting the protocol. Counted from the
 *      marker-shaped lines alone (`markerLines`), NOT from prose: a reviewer
 *      that argues "this is ISSUES_FOUND rather than CRITICAL_ISSUES_FOUND" and
 *      then closes with `VERDICT: ISSUES_FOUND` has chosen, and stops;
 *   4. the matched line sits inside (or after an uncountable number of) fenced
 *      blocks — a reviewer pasting a fence containing `VERDICT: APPROVED` into
 *      its report is showing an example;
 *   5. the value the candidate lines agree on CONTRADICTS the value the block as
 *      a whole reads to (the reader `parseVerdict` runs). A block whose line-level
 *      markers all say one thing while the whole-text reader lands on another is
 *      carrying a marker those lines do not account for — an echo or a quotation
 *      that out-ranked the closing line — so nothing is pointed at, and a shape we
 *      cannot point at is not an ending.
 *
 * The value itself comes from `readEnumMarker`, the same reader `parseVerdict`
 * uses, applied to the ONE block and the ONE line that block ends on — so
 * emphasis, case and the heading form keep working, and the line judged is the
 * line that produced the value rather than any line that happens to contain it.
 */
export function verdictEndingMessage(msg: PiMessage): VerdictStatus | undefined {
  for (const block of msg.content ?? []) {
    if (block.type === "toolCall") return undefined;
  }
  const blocks = textBlocksOf(msg);
  const last = blocks[blocks.length - 1];
  if (last === undefined) return undefined;
  // The distinct-verdict count and the marker are read from the SAME unfenced,
  // marker-shaped lines (#1827 round 4) — never from any occurrence of a status
  // word in prose. Counting words in the whole block made the stop depend on how
  // the reviewer PHRASED its reasoning: "This is ISSUES_FOUND rather than
  // CRITICAL_ISSUES_FOUND because…\n\nVERDICT: ISSUES_FOUND" names two values in
  // prose and one in the closing line, and is a review that finished. The menu,
  // by contrast, is four marker-shaped lines, so it is four distinct verdicts
  // under this rule and stops nothing either way.
  const closingLines = markerLines(last);
  if (closingLines.length === 0) return undefined;
  // Refusal 3 in its round-4 form: the block must not be reciting the protocol
  // (the brief's menu, a quoted example line, a placeholder template). Counting
  // status WORDS anywhere in the block refused that along with an ordinary review
  // that argues about the verdicts in prose before signing one; the marker SYNTAX
  // test below separates the two.
  if (blockRefusesVerdict(last)) return undefined;
  const named = new Set<VerdictStatus>();
  for (const line of closingLines) {
    const v = readEnumMarker(line, "VERDICT", VERDICT_STATUSES);
    if (v) named.add(v);
  }
  // A block whose only candidate line is a HEADING names no value at the line
  // level; the value is on the line below it, and the closing-line search below is
  // what reads it. Any other block must agree on exactly one value.
  if (named.size !== 1 && closingLines.every((l) => VERDICT_HEADING_RE.test(l))) {
    const heading = closingLines[0] as string;
    const at = last.split("\n").indexOf(heading);
    const value = last
      .split("\n")
      .slice(at + 1)
      .find((l) => l.trim() !== "");
    const upper = value?.trim().toUpperCase();
    const only = VERDICT_STATUSES.find((s) => s === upper);
    if (only === undefined) return undefined;
    return fencePositionOf(value as string, countFencesBefore(last, at)) === "outside"
      ? only
      : undefined;
  }
  if (named.size !== 1) return undefined;
  const hit = [...named][0];
  if (hit === undefined) return undefined;
  // The value the block ENDS with: the LAST line-level match that the block's
  // own candidate lines agree to, so a verdict that was considered earlier and
  // superseded cannot close the message, and neither can a menu line or a
  // template the block merely carries. The heading form is the exception it has
  // always been: its candidate IS the heading (`### VERDICT`), whose value sits on
  // the next non-empty line, so that line is what carries the value here — and a
  // block that quotes the protocol cannot close on a heading candidate it never
  // had, because the heading is the only line that matches it.
  const candidates = new Set(closingLines);
  let closingLine: string | undefined;
  let fencesAtClosing = 0;
  let fences = 0;
  const lines = last.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // The heading form's value sits on its own line, so it does not answer to a
    // line-level read on its own — compare it to the enum directly.
    let matched = false;
    let valueLine = line;
    if (candidates.has(line)) {
      if (VERDICT_HEADING_RE.test(line)) {
        const next = lines.slice(i + 1).find((l) => l.trim() !== "");
        if (next && next.trim().toUpperCase() === hit) {
          matched = true;
          valueLine = next;
        }
      } else if (readEnumMarker(line, "VERDICT", VERDICT_STATUSES) === hit) {
        matched = true;
      }
    }
    if (matched) {
      closingLine = valueLine;
      fencesAtClosing = fences;
    }
    if (isFenceLine(line)) fences += 1;
  }
  if (closingLine === undefined) {
    // An inline match no single line reproduces. Requiring the line-level match
    // to agree is the conservative side: no line we can point at, no stop.
    return undefined;
  }
  return fencePositionOf(closingLine, fencesAtClosing) === "outside" ? hit : undefined;
}
