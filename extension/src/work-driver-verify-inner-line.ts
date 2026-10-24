/**
 * work-driver-verify-inner-line — #1762: the harness WRAPPER read, as distinct
 * from the plain failure-line table.
 *
 * Split out of `work-driver-verify-failures.ts` (AGENTS.md §12 file-size cap).
 * The table module asks this module one question — "is this line the harness's
 * wrapper around a gate stream, and what is the gate's own text behind it?" — and
 * gets back a stream already cut past every piece of the harness's own writing, so
 * no reader re-derives offsets from a stream it was handed. Two kinds of harness
 * text used to ride along into the field labelled "the gate's output":
 *
 *   - **Separator padding.** The first cut whose stream classifies can sit inside a
 *     command string or a cwd that carries `: ` of its own, which left `: : : ` in
 *     front of the gate's line.
 *   - **Deps-hint prose.** When the accepted cut is the colon inside the deps hint
 *     (the only cut that reaches the gate's tail behind a hint), the returned stream
 *     opened with the harness's diagnosis — `node_modules is empty: scripts/gate.sh:
 *     failed checks (1)` — quoting the driver's own sentence as the gate's output.
 *
 * The graph stays a DAG by DIRECTION, not by luck. This module imports the table
 * module's plain shape test (`matchShape`) — the non-wrapper arm, which never comes
 * back here — and the table module imports this module's cut. The one dependency
 * that would have closed the cycle is inverted: which line of a stream is "the
 * first real one" is decided by a predicate the CALLER hands {@link
 * stripHarnessResidue}, and that caller is the cut below, which already holds
 * `matchShape`. Nothing in the classifier's wrapper path is reached from here.
 */

import { DEPS_HINT_STARTS } from "./work-driver-deps-hint.ts";
import { matchShape } from "./work-driver-verify-failures.ts";
import { LEADING_SEPARATOR, splitLines } from "./work-driver-verify-support.ts";

/** The harness sentence's own words, up to and including `failed in `. */
const HARNESS_PROSE = /^verify command\s.+?\sfailed in\s/i;
/** The builder's stream separator, and its width — the offset a cut skips. */
const STREAM_SEPARATOR = ": ";
const STREAM_SEPARATOR_LEN = STREAM_SEPARATOR.length;
/** How far past the hint's end its own separators are searched for. */
const HINT_PROSE_MAX = 320;
/** What one separator costs, and the cap that keeps every scan below constant. */
const SEPARATOR_LEN = STREAM_SEPARATOR_LEN;
const COLON_SCAN_MAX = 16;

/**
 * The harness's own wrapper sentence, recognised. Exported so every reader agrees
 * on what a wrapper IS: `work-driver-verify-record.ts` used to keep its own copy of
 * this regex, and a reader that disagrees about the wrapper disagrees about which
 * lines a developer can act on.
 */
export function isHarnessWrapper(line: string): boolean {
  return HARNESS_PROSE.test(line);
}

/**
 * Where this line's deps hint begins, or `undefined` when it carries none.
 *
 * The hint is what `provisionDepsHint` appends to the harness's own sentence before
 * `formatExecError` appends the gate's tail, and each of its shapes opens with one
 * of `DEPS_HINT_STARTS` — the same phrase list `work-driver-cause-scrub.ts` strips,
 * so the cut and the scrub agree on what the hint is instead of each guessing.
 *
 * Exported because the reader that must not mistake the harness's diagnosis for the
 * gate's output is a different function from the one that cuts: a wrapper whose
 * hint says `hook failed during provisioning: Cannot find module 'x'` would
 * otherwise answer "the stream is `Cannot find module 'x'`" — the hint's own problem
 * text presented as a failure the gate printed, which is what makes `depsHintApplies`
 * keep a hint that #1667 exists to suppress.
 */
export function depsHintStartFor(line: string): number | undefined {
  let start: number | undefined;
  for (const opener of DEPS_HINT_STARTS) {
    const at = line.indexOf(opener);
    if (at !== -1 && (start === undefined || at < start)) start = at;
  }
  return start;
}

/**
 * How many candidate separators one wrapper line is scanned for. The builder
 * appends exactly ONE stream separator and at most one line break, and the deps hint
 * can add a couple of its own, so the real candidate set is tiny; the cap is what
 * makes a pathological 8 KiB of `: ` inside a command string cost a constant.
 */
const STREAM_CANDIDATES_MAX = 16;

/**
 * Every offset in `line` at or after `from` where the builder could have put the
 * stream, in order: the `: ` it appends, and the newline that separates the harness
 * sentence from a multi-line tail.
 */
function streamSeparators(line: string, from: number): number[] {
  const candidates: number[] = [];
  const push = (at: number): void => {
    if (at !== -1 && (candidates.length === 0 || candidates[candidates.length - 1] !== at)) {
      candidates.push(at);
    }
  };
  // A BOUNDED WALK, not `indexOf` over the whole line: on the 1 MB wrapper line
  // #1762 round 3 measured, an unbounded scan found 131 000 candidates and the
  // harness prefix's lazy `\.+?` backtracked over every one of them (249 s unbounded
  // The walk runs to the end of the line it is given — the caller has already
  // bounded that line, so the walk is bounded with it — and the candidate cap below is
  const scanTo = line.length;
  for (let at = line.indexOf(STREAM_SEPARATOR, from); at !== -1 && at < scanTo; ) {
    push(at);
    if (candidates.length >= STREAM_CANDIDATES_MAX) break;
    at = line.indexOf(STREAM_SEPARATOR, at + STREAM_SEPARATOR_LEN);
  }
  // The first line break at or after `from`, found without copying the tail: a
  // 1 MB line's `slice(from)` is a megabyte of allocation per candidate scan.
  for (let k = from; k < line.length && k < scanTo; k++) {
    const c = line[k];
    if (c === "\r" || c === "\n") {
      push(k);
      break;
    }
  }
  return candidates;
}

/**
 * The hint's own `: ` positions, in offsets into `line`, in the window
 * `[first, first + HINT_PROSE_MAX)` — `first` is the first offset at or after
 * `from`, which may be negative when `line` begins after the point `from` was
 * measured from. A colon in that window is part of the hint's problem text, so a
 * slice that stops just past it still sheds the harness's prose; a colon past the
 * window is the gate's own output and is never a cut. The scan starts one separator
 * before `first` so a colon ending exactly at it counts too, and both bounds are
 * clamped because the stream is a truncated window of the line. `COLON_SCAN_MAX`
 * keeps this a constant scan whatever the line holds.
 */
function hintColonPositions(line: string, from: number): number[] {
  const first = Math.max(0, from);
  const last = Math.min(line.length, first + HINT_PROSE_MAX);
  const cols: number[] = [];
  for (let at = line.indexOf(STREAM_SEPARATOR, Math.max(0, first - SEPARATOR_LEN)); at !== -1; ) {
    if (at < last) cols.push(at);
    if (at >= last || cols.length >= COLON_SCAN_MAX) break;
    at = line.indexOf(STREAM_SEPARATOR, at + SEPARATOR_LEN);
  }
  return cols;
}

/**
 * Remove the harness's own writing from a stream {@link harnessVerifyStream} cut out
 * of a wrapper line.
 *
 * @param stream the gate's stream exactly as the cut produced it
 * @param trimmed the wrapper line, already trimmed (the offsets below share its
 *   space, so a line trimmed twice would shift every one of them)
 * @param cut where the accepted separator sits in `trimmed`, or -1 when the wrapper
 *   carries no stream that reports a failure
 * @param streamStart where `stream` begins in `trimmed`, past that separator
 * @param classify the table's shape test for one line, supplied by the caller so
 *   this module never calls back into the classifier's wrapper path
 * @param hintAt where this line's deps hint begins, or `undefined` when none
 */
export function stripHarnessResidue(
  stream: string,
  trimmed: string,
  cut: number,
  streamStart: number,
  classify: (line: string) => boolean,
  hintAt: number | undefined,
): string {
  const lines = splitLines(stream);
  // The first line of the stream the table recognises: everything before it is the
  // wrapper's and the hint's own writing, so the returned text starts there.
  const first = lines.findIndex((l) => classify(l));
  const head = stream.replace(LEADING_SEPARATOR, "");
  if (first < 0) return head;
  let start = 0;
  for (let i = 0; i < first; i++) start += (lines[i] ?? "").length + 1;
  const line = lines[first] ?? "";
  const kept = line.replace(LEADING_SEPARATOR, "");
  // Without a hint there is nothing here but padding to remove, and the ordinary
  // cut's stream is already the gate's own output. A cut from before the hint — a
  // command or cwd that carries a `: ` of its own — is the builder's own separator,
  // so its stream is the gate's output too.
  if (hintAt === undefined || cut < hintAt) return `${head.slice(0, start)}${kept}`;
  // The cut is inside the hint, so the line the reader would get opens with the
  // harness's own diagnosis. `cutEnd` is where the cut's separator ENDS, in this
  // line's own space: the line begins `gap` bytes after the cut, so the cut's own
  // separator — the one the hint ends with — sits at `SEPARATOR_LEN - gap`. The
  // slice starts just past the last `: ` at or before that point: the hint's problem
  // text can itself carry a colon, and stopping at the cut's own would still quote it
  // as the gate's output. A colon past the hint's window belongs to the gate's own
  // line and is never the cut, which keeps the evidence from being eaten.
  const gap = streamStart + start + (line.length - kept.length) - cut;
  const cutEnd = SEPARATOR_LEN - gap;
  if (cutEnd < 0 || cutEnd > kept.length) return `${head.slice(0, start)}${kept}`;
  const cols = hintColonPositions(kept, cutEnd);
  for (let k = cols.length - 1; k >= 0; k--) {
    const sliced = kept.slice((cols[k] ?? 0) + SEPARATOR_LEN);
    if (classify(sliced)) return sliced.replace(LEADING_SEPARATOR, "");
  }
  // No slice of this line classifies: the cut sits on another line of the stream, so
  // this line is the gate's own and is returned as the cut produced it (the reader's
  // line-by-line pass still reaches the lines below it).
  return `${head.slice(0, start)}${kept}`;
}

/**
 * A cut {@link harnessVerifyStream} accepted: the gate's stream, already cut past
 * every piece of the harness's own writing, plus the two offsets
 * {@link stripHarnessResidue} needs to measure the hint's own colon in the whole
 * line's offset space.
 */
export interface HarnessStream {
  stream: string;
  /** -1 when no separator reported a failure (the #1667 exemption). */
  cut: number;
  /** Where `stream` begins in `line`, past the separator the cut landed on. The
   * classifier measures its scan window from here, so the harness's own prefix
   * cannot consume the budget the gate's report needs. */
  streamStart: number;
}

/**
 * Where the gate's own output begins inside a harness line, or `undefined` when the
 * line is not the harness's wrapper. `{ stream: "", cut: -1 }` means the wrapper
 * carries no stream that reports a failure — it asserts only that a run exited
 * non-zero, which is not a line of the gate's output naming anything (#1667's
 * exemption).
 *
 * Two rules, both from #1762:
 *
 *   - The wrapper itself is NEVER a failure line. #1667's corrective-round exemption
 *     depends on this staying unclassified when nothing behind it does: the harness
 *     saying a run exited non-zero is not a line of the gate's output naming a
 *     failure, and the whole no-assertion suite (`… failed in <cwd>: something went
 *     wrong` earns no round) rests on that.
 *   - What sits BEHIND the wrapper is classified normally, so a TAP, pytest or `✗`
 *     line wrapped by the harness reports what it reports unwrapped. An early version
 *     used the inner stream only as an existence veto and then matched the WHOLE
 *     wrapped line against the table, which silently dropped every anchored shape
 *     (`^✗\s`, `^ERROR \S+::`, `^--- FAIL:`) and let the loose `named-file` rule
 *     classify the wrapper's own prose.
 *
 * What the builder actually emits, read from the call site that composes it
 * (`work-driver-verify-per-worktree.ts`, which calls `formatExecError` with
 * `failMsg = "verify command \`<cmd>\` failed in <cwd>" + depsHint`, and the helper
 * then appends the extracted tail after `: ` — and a stream that spans several lines
 * may carry no `: ` at all). So a candidate is the builder's `: ` OR the first line
 * break after `failed in`, and one is chosen as soon as what follows it reports a
 * failure — EXCEPT the separators that sit inside the deps hint, which is why
 * {@link depsHintStartFor} exists rather than a bare scan: a hint whose problem text
 * reads `hook failed during provisioning: Cannot find module 'x'` is the harness's
 * own diagnosis, and cutting inside it promotes that diagnosis to "the gate's
 * output", which is the #1667 suppression made backwards. The ONE separator inside
 * the hint that stays a candidate is the hint's own `: ` — `formatExecError` appends
 * the gate's tail after the whole `failMsg` including the hint, so that is where the
 * builder's separator sits. With a clean gate output no candidate reports a failure
 * and the wrapper stays unclassified (#1667's exemption), and with a hint that
 * carries its own `: ` the earlier cut yields a stream whose first lines carry no
 * failure, so the scan moves on. Cutting at the LAST `: ` instead would make a
 * hinted line report no failure at all, because the tail after the hint's colon is a
 * single line. project-runner's `…failed in /w: test.sh: failed checks (1)` still
 * names its file.
 *
 * PRECONDITION: `line` is already a scan-window of the caller's line — the table
 * module's `classifyFailureLine` and `harnessInnerLine` both clip before calling.
 * This function does NOT re-clip the LINE: a second bound would be applied to the
 * streams and still leave the caller's unbounded text to this function's own scans,
 * which is the quadratic cost #1762 round 3 removed. The stream a cut produces, on
 * the other hand, is asked to the END of the line it was cut from, which is what
 * makes the 8 KiB window a window on THE GATE'S OWN STREAM rather than on the whole
 * line: a wrapper whose command string runs long does not get to eat the gate's
 * report out of the window.
 *
 * One classification per candidate line. Each later candidate's stream is a SUFFIX
 * of every earlier one, so scanning candidate N+1 re-scanned every line candidate N
 * had already judged — with the builder's separator plus the hint's own, a wrapped
 * stream was classified two and three times over. Lines are judged ONCE and cached,
 * and that cache answers both questions this cut asks: does the stream report a
 * failure at all, and which line of it is the first.
 */
export function harnessVerifyStream(line: string): HarnessStream | undefined {
  const matched = HARNESS_PROSE.exec(line);
  if (matched === null) return undefined;

  // The prefix is anchored and matched against the same trimmed line, so `failed in `
  // sits at a fixed offset from the start: everything before it is the wrapper's own
  // wording, never the gate's.
  const afterFailedIn = matched[0].length;
  // Where the harness's own diagnostic begins, when the run carried one. Every
  // separator from there on belongs to the hint — EXCEPT the hint's own `: `, on
  // which `formatExecError` appended the gate's tail: that is the builder's separator
  // and the only cut that reaches a multi-line tail sitting behind a hint. Treating it
  // as hint text too would make a hinted wrapper report no failure at all, which is
  // the opposite defect from the one it prevents.
  // The hint's start is searched across the whole line the caller handed over, which
  // is already a bounded window of it — see the caller's `scanWindow`.
  const hintAt = depsHintStartFor(line);
  const hintColon =
    hintAt === undefined ? -1 : line.indexOf(STREAM_SEPARATOR, hintAt + STREAM_SEPARATOR_LEN);
  // Each candidate is a separator the builder could have appended. Everything before
  // the chosen one belongs to the command, the cwd or the deps hint — all three may
  // legitimately contain a colon or a newline.
  for (const at of streamSeparators(line, afterFailedIn)) {
    if (hintAt !== undefined && at >= hintAt && at !== hintColon) continue;
    // The separator is a `: ` or a line break, so its width is either two or three —
    // measure it rather than assume, or a newline cut leaks an `r`.
    const width = line.startsWith(STREAM_SEPARATOR, at)
      ? STREAM_SEPARATOR_LEN
      : line[at] === "\r" && line[at + 1] === "\n"
        ? 2
        : 1;
    // No clip here: the caller clipped the text it hands this function, so this slice
    // cannot exceed that window and the bound is never applied a second time.
    const raw = line.slice(at + width).trim();
    if (raw.length === 0) continue;
    const judged = new Map<string, boolean>();
    const judge = (l: string): boolean => {
      if (!judged.has(l)) judged.set(l, matchShape(l) !== undefined);
      return judged.get(l) === true;
    };
    // The candidate is accepted on the CUT's own text, not on the stripped form the
    // reader is shown: a strip that moved the first recognised line out of the table's
    // reach would otherwise make a wrapped gate report no failure at all, which is the
    // opposite defect from the one the strip exists to fix.
    const first = splitLines(raw).findIndex((l) => judge(l));
    if (first < 0 && !judge(raw)) continue;
    const reported = stripHarnessResidue(raw, line, at, at + width, judge, hintAt);
    if (reported.length === 0) continue;
    return {
      stream: reported,
      cut: at,
      streamStart: at + width,
    };
  }
  return { stream: "", cut: -1, streamStart: -1 };
}
