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
import type { PiMessage } from "./pi-event-shapes.ts";
import { readEnumMarker } from "./reply-markers.ts";

/** A verdict status in its canonical spelling. */
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

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

function fencePositionOf(line: string, fencesBefore: number): FencePosition {
  if (isFenceLine(line)) return "inside";
  if (fencesBefore > MAX_FENCE_LINES) return "unknown";
  return fencesBefore % 2 === 0 ? "outside" : "inside";
}

/** Does this line open or close a fenced block? */
function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/** The non-empty text blocks of a message, in stream order. */
function textBlocksOf(msg: PiMessage): string[] {
  const out: string[] = [];
  for (const block of msg.content ?? []) {
    if (block.type === "text" && block.text) out.push(block.text);
  }
  return out;
}

/** How many DISTINCT verdict values a piece of text names. */
function distinctVerdicts(text: string): Set<VerdictStatus> {
  const named = new Set<VerdictStatus>();
  for (const status of VERDICT_STATUSES) {
    if (new RegExp(`\\b${status}\\b`, "i").test(text)) named.add(status);
  }
  return named;
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
 *   3. the block names more than one distinct verdict — the reviewer's own
 *      prompt (`buildAdversarialPrompt`) hands the model a menu of all four, so
 *      a reply that echoes the menu, or quotes two examples to compare them, is
 *      reciting the protocol. It is also the honest reading of "this is
 *      ISSUES_FOUND, not APPROVED": a block that weighs two verdicts has not
 *      chosen;
 *   4. the matched line sits inside (or after an uncountable number of) fenced
 *      blocks — a reviewer pasting a fence containing `VERDICT: APPROVED` into
 *      its report is showing an example.
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
  if (distinctVerdicts(last).size !== 1) return undefined;
  const hit = readEnumMarker(last, "VERDICT", VERDICT_STATUSES);
  if (!hit) return undefined;
  // The value the block ENDS with: the LAST line-level match, so a verdict that
  // was considered earlier and superseded cannot close the message.
  let closingLine: string | undefined;
  let fencesAtClosing = 0;
  let fences = 0;
  const lines = last.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // The heading form's value sits on its own line, so it does not answer to a
    // line-level read on its own — compare it to the enum directly.
    let matched = readEnumMarker(line, "VERDICT", VERDICT_STATUSES) === hit;
    let valueLine = line;
    if (!matched && /^\s*#{1,6}\s*\**\s*VERDICT\s*\**\s*$/.test(line)) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      if (next && next.trim().toUpperCase() === hit) {
        matched = true;
        valueLine = next;
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
