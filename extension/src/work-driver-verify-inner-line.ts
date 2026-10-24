/**
 * work-driver-verify-inner-line — #1762: what a reader is SHOWN for a
 * harness-wrapped verify failure, as distinct from what the table classifies.
 *
 * Split out of `work-driver-verify-failures.ts` (AGENTS.md §12 file-size cap).
 * The classifier owns the table and the cut; this module owns only the text
 * returned to a human-facing field, which is where two kinds of the harness's
 * own writing used to ride along:
 *
 *   - **Separator padding.** `harnessInnerLine` returns the FIRST cut whose
 *     stream classifies, so a command string or a cwd containing `: ` makes the
 *     "specific assertion" start with `: : : ` before the gate's line.
 *   - **Deps-hint prose.** When the accepted cut is the colon inside the hint
 *     (the only cut that reaches the gate's tail behind a hint), the returned
 *     stream opened with the harness's diagnosis —
 *     `node_modules is empty: scripts/gate.sh: failed checks (1)` — quoting the
 *     driver's own sentence as the gate's output.
 *
 * Neither removal touches classification: `classifyFailureLine` reads the stream
 * through `harnessVerifyStream` directly and never calls into this file. Both
 * removals only ever move the start FORWARD, so what comes back is a suffix of
 * what went in and a miss costs the old text rather than an invention.
 */

import {
  classifyFailureLine,
  depsHintStartFor,
  splitLines,
} from "./work-driver-verify-failures.ts";

/** The leading run of stream separators a returned stream can carry. */
const LEADING_SEPARATOR = /^(?::\s+)+/;

/** The separator that opens a deps hint's own problem text. */
const HINT_PROSE_SEPARATOR = ": ";
/** How far past the hint's end its own separators are searched for. */
const HINT_PROSE_MAX = 320;
/** What one separator costs, and the cap that keeps every scan below constant. */
const SEPARATOR_LEN = HINT_PROSE_SEPARATOR.length;
const COLON_SCAN_MAX = 16;

/**
 * The hint's own `: ` positions, in offsets relative to `line`, in the window
 * `[first, first + HINT_PROSE_MAX)` — `first` is the first offset at or after
 * `from`, which may be negative when `line` begins after the point `from` was
 * measured from. A colon in that window is part of the hint's problem text, so
 * a slice that stops just past it still sheds the harness's prose; a colon past
 * the window is the gate's own output and is never a cut. The scan starts one
 * separator before `first` so a colon ending exactly at it counts too, and both
 * bounds are clamped because the stream is a truncated window of the line.
 * `COLON_SCAN_MAX` keeps this a constant scan whatever the line holds.
 */
function hintColonPositions(line: string, from: number): number[] {
  const first = Math.max(0, from);
  const last = Math.min(line.length, first + HINT_PROSE_MAX);
  const cols: number[] = [];
  for (
    let at = line.indexOf(HINT_PROSE_SEPARATOR, Math.max(0, first - SEPARATOR_LEN));
    at !== -1;
  ) {
    if (at < last) cols.push(at);
    if (at >= last || cols.length >= COLON_SCAN_MAX) break;
    at = line.indexOf(HINT_PROSE_SEPARATOR, at + SEPARATOR_LEN);
  }
  return cols;
}

/**
 * Remove the harness's own writing from a stream {@link harnessVerifyStream}
 * cut out of a wrapper line.
 *
 * @param stream the gate's stream exactly as the cut produced it
 * @param trimmed the wrapper line, already trimmed (the offsets below share its
 *   space, so a line trimmed twice would shift every one of them)
 * @param cut where the accepted separator sits in `trimmed`, or -1 when the
 *   wrapper carries no stream that reports a failure
 * @param streamStart where `stream` begins in `trimmed`, past that separator
 */
export function stripHarnessResidue(
  stream: string,
  trimmed: string,
  cut: number,
  streamStart: number,
): string {
  const lines = splitLines(stream);
  // The first line of the stream the table recognises: everything before it is
  // the wrapper's and the hint's own writing, so the returned text starts there.
  const first = lines.findIndex((l) => classifyFailureLine(l) !== undefined);
  const head = stream.replace(LEADING_SEPARATOR, "");
  if (first < 0) return head;
  let start = 0;
  for (let i = 0; i < first; i++) start += (lines[i] ?? "").length + 1;
  const line = lines[first] ?? "";
  const kept = line.replace(LEADING_SEPARATOR, "");
  const hintAt = depsHintStartFor(trimmed);
  // Without a hint there is nothing here but padding to remove, and the
  // ordinary cut's stream is already the gate's own output. A cut from before
  // the hint — a command or cwd that carries a `: ` of its own — is the
  // builder's own separator, so its stream is the gate's output too.
  if (hintAt === undefined || cut < hintAt) return `${head.slice(0, start)}${kept}`;
  // The cut is inside the hint, so the line the reader would get opens with the
  // harness's own diagnosis. `cutEnd` is where the cut's separator ENDS, in this
  // line's own space: the line begins `gap` bytes after the cut, so the cut's
  // own separator — the one the hint ends with — sits at `SEPARATOR_LEN - gap`.
  // The slice starts just past the last `: ` at or before that point: the
  // hint's problem text can itself carry a colon, and stopping at the cut's own
  // would still quote it as the gate's output. A colon past the hint's window
  // belongs to the gate's own line and is never the cut, which keeps the
  // evidence from being eaten.
  const gap = streamStart + start + (line.length - kept.length) - cut;
  const cutEnd = SEPARATOR_LEN - gap;
  if (cutEnd < 0 || cutEnd > kept.length) return `${head.slice(0, start)}${kept}`;
  const cols = hintColonPositions(kept, cutEnd);
  for (let k = cols.length - 1; k >= 0; k--) {
    const sliced = kept.slice((cols[k] ?? 0) + SEPARATOR_LEN);
    if (classifyFailureLine(sliced) !== undefined) return sliced.replace(LEADING_SEPARATOR, "");
  }
  // No slice of this line classifies: the cut sits on another line of the
  // stream, so this line is the gate's own and is returned as the cut produced
  // it (the reader's line-by-line pass still reaches the lines below it).
  return `${head.slice(0, start)}${kept}`;
}
