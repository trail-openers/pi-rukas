/**
 * work-driver-verify-failures — #1762: ONE table of failure-line shapes, read
 * by every verify-evidence reader in the driver.
 *
 * The defect this closes. Four recognisers each hardwired the same two shapes
 * — `FAILED: <x>` and `✗ <x>` (plus the driver's own tsc/biome dialect):
 * `FAILED_MARKER_RE` (work-driver-exec-error.ts), `IS_ASSERTION_LINE`
 * (work-driver-consolidation-classify.ts), `NAMED_FAILURE_LINE`
 * (work-driver-commit-verify-evidence.ts) and `ERROR_MARK` / `tailLines`
 * (work-driver-cause-class.ts). A project whose gate is not this repo's
 * `smoke-tests/lib/verify-loop.sh` matched none of them, so on tehas v0.14.2
 * nine verify parks named no failing assertion and the quoted evidence pointed
 * at a stage that had PASSED — the runner's own `test.sh: failed checks (1)`
 * block sat earlier in the same window and was dropped.
 *
 * Two rules the shapes must obey, both learned from that misquote:
 *
 *   - A line that reports SUCCESS is never a failure line. `pack_release_test.sh:
 *     36 cases, 0 failed` contains the substring `fail`, matches a naive
 *     `/error|fail/i`, and was printed as the top evidence of a handoff. So every
 *     classifier asks `isSuccessLine` first, and a key that can also occur inside
 *     an ordinary word is anchored (`^\s*ok\s+\d`, never /ok/).
 *   - One line, one shape. The table is tried in priority order and the first
 *     match wins, so `not ok 3 - x` reports `not-ok` and never `ok`.
 *
 * `namesTest` is the stricter half of the answer — the line that carries a
 * specific assertion or a named check, which is what `extractSpecificAssertion`
 * and the corrective-round gate require. A bare `FAIL` tally does not name one,
 * and stays false so an honest absence still reports absence.
 */

import { DEPS_HINT_STARTS } from "./work-driver-deps-hint.ts";

/** The shape a line was recognised as. Stable strings: tests pin them. */
export type FailureShape =
  | "failed-marker"
  | "assertion-mark"
  | "diagnostic"
  | "script-tally"
  | "named-file"
  | "tap-not-ok"
  | "pytest-failed"
  | "pytest-error"
  | "go-fail";

/** What `classifyFailureLine` decided about one line. */
export interface FailureLine {
  shape: FailureShape;
  /** True when the line carries a specific assertion or named check. */
  namesTest: boolean;
}

/**
 * The table, in priority order. Each entry is tried against the whole line and
 * the first match wins, so the two pi-rukas literals (which a generic rule also
 * contains) sit ahead of `diagnostic`, and every success-adjacent key is
 * anchored. Three rules every key obeys:
 *
 *   - A FAILURE TOKEN in its own position, not a substring. A word that also
 *     occurs inside ordinary prose (`error`, `cannot`, `not found`) is matched
 *     only where a runner prints it as a status — `a.ts: error`, never
 *     `index.ts: fatal error` — because a line that classifies becomes the
 *     evidence anchor with `attributed: true` and can earn a corrective round.
 *   - One line, one shape: the table stops at the first match, so `not ok 3 - x`
 *     reports `not-ok` and never `ok`.
 *   - A count, where the shape has one, is a NON-ZERO count. `isSuccessLine`
 *     already settles the `0 failed` tally before the table is asked; the
 *     `[1-9]` keeps that true for a shape `isSuccessLine`'s patterns do not
 *     cover.
 */
const SHAPES: ReadonlyArray<{ shape: FailureShape; namesTest: boolean; re: RegExp }> = [
  // `.pi/verify-cmd`'s smoke loop: the per-file marker and its count summary.
  { shape: "failed-marker", namesTest: false, re: /^FAILED: .+$/ },
  // The loop's / biome's assertion mark — `✗`, never the passing `✓`.
  { shape: "assertion-mark", namesTest: true, re: /^✗\s/ },
  // The driver's own dialect: tsc, cargo rustc, and bare `error:`/`Error:` lines.
  {
    shape: "diagnostic",
    namesTest: true,
    re: /^error:?\s|^Error:|error\[E\d+\]|\bTS\d{4,}\b/,
  },
  // The tehas shape: a script's own summary block naming its failing checks.
  {
    shape: "script-tally",
    namesTest: true,
    re: /[\w./-]+\.(?:sh|bash|py|js|ts|go|rs)\s*:\s*(?:failed|failing)\s+checks?\s*\(\s*[1-9]\d*\s*\)/i,
  },
  // A script/file line that says it failed, in the shapes a runner actually
  // prints: `<file>: failed|FAILED|FAIL|ERROR`, `<file> … FAILED`, `<file>: N
  // failed` / a comma tally `<cases>, N failed` with N >= 1, and a leading
  // `FAIL <file>`.
  //
  // Prose that merely contains the word error, `cannot` or `not found`
  // (`index.ts: fatal error`, `index.ts: cannot parse`,
  // `src/a.ts: consider this error case`) is NOT one of them — it names no
  // failed check, and classifying it would make that prose the anchor. The
  // status must sit DIRECTLY after the file's colon (`:\s*`, never a lazy
  // `.*?`), or after a comma inside a tally (`,\s*`): `index.ts: fatal error`
  // puts a word between them, so `error` there is prose, not the status the
  // line reports. The `(?<=\s)FAILED(?=\W|$)`
  // branch is the `<file> … FAILED` shape (go's `foo_test.go  FAILED`), and the
  // two `[1-9]` branches are the counted tallies — one directly after the
  // file's colon (`test.sh: 2 errors`) and one as the failing half of a
  // comma-separated tally that starts at that colon
  // (`pack_release_test.sh: 36 cases, 1 failed`, whose colon is taken by the
  // passing half, so the count is reached through `[^\r\n]*,` rather than by
  // matching a bare comma — a bare comma would let prose like
  // `index.ts: not found in the fixture, which is fine` in). `isSuccessLine`
  // settles the zero case of both.
  {
    shape: "named-file",
    namesTest: true,
    re: /^\s*FAIL\s+[\w./-]+\.(?:sh|bash|py|js|jsx|ts|tsx|mjs|go|rs|rb|java|c|cpp|kt)\b/i,
  },
  {
    shape: "named-file",
    namesTest: true,
    re: /[\w./-]+\.(?:sh|bash|py|js|jsx|ts|tsx|mjs|go|rs|rb|java|c|cpp|kt)\b\s*(?::\s*(?:failed|failing|fail|error)\b|(?<=\s)FAILED(?=\W|$)|:\s*[1-9]\d*\s+(?:failed|errors?|failures?)\b|:[^\r\n]*,\s*[1-9]\d*\s+(?:failed|errors?|failures?)\b)/i,
  },
  // TAP / bats. Anchored with a number so `book`, `token` and `lookup` never match.
  { shape: "tap-not-ok", namesTest: true, re: /^\s*not\s+ok\b/i },
  // pytest's own failing lines (pytest also prints `path::name` tallies).
  { shape: "pytest-failed", namesTest: true, re: /^FAILED\s+\S+::/ },
  { shape: "pytest-error", namesTest: true, re: /^ERROR\s+\S+::/ },
  // go test.
  { shape: "go-fail", namesTest: true, re: /^\s*---\s+FAIL:\s+\S+/ },
];

/**
 * Lines that report SUCCESS. Checked before the table: a passing tally is not a
 * failure line, whatever substring it contains. Every key is anchored or counted,
 * because a bare `/ok/` also matches book, token, lookup and OK — and every
 * passing-tally veto is conditional on the line carrying no NON-ZERO failure
 * count (`NONZERO_FAILURE_COUNT`), because a tally that reports both halves
 * (`1 failed, 3 passed`) is a failure.
 */
const SUCCESS_LINE =
  /^\s*✓|^\s*ok\s|\b0\s+(?:failed|failures|errors|fail)\b|\b\d+\s+(?:passed|passed,)\b|^\s*PASS\b|^\s*PASS\s|:?\s*\d+\s+cases,\s*0\s+failed|\bfailed\s+checks?\s*\(\s*0\s*\)|\b0\s+(?:failed|failing)\s+checks?\b/i;

/**
 * A NON-ZERO failure count in a status position: right after the file's colon
 * (`test.sh: 1 failed`), as the failing half of a comma-separated tally that
 * starts at that colon (`pack_release_test.sh: 36 cases, 1 failed`), or bare
 * after whitespace (`1 failed, 3 passed` at the head of a summary). `isSuccessLine` applies its
 * passing vetoes only when a line carries none of these — the passing half of a
 * tally does not cancel the failing half — and prose that merely uses the words
 * (`index.ts: not found, which is fine`) matches none of the three positions.
 */
const NONZERO_FAILURE_COUNT =
  /:\s*[1-9]\d*\s+(?:failed|errors?|failures?)\b|:[^\r\n]*,\s*[1-9]\d*\s+(?:failed|errors?|failures?)\b|(?<![\d.])[1-9]\d*\s+(?:failed|errors?|failures?)\b/i;

/**
 * #1762 lens round — the longest line the classifier inspects.
 *
 * A verify gate can print a whole document on one line (a serialized fixture
 * diff, a JSON dump), and the classifier is quadratic in line length: the
 * wrapper prefix's lazy `.+?` backtracks over the line once per `: ` it finds,
 * and the tally branches' `[^\r\n]*` does the same. A 200 KB line cost seconds
 * and would eventually stop the gate. Classifying on the first 8 KiB keeps
 * every real failure shape (no runner prints a status keyword 8 KiB into one
 * line) and makes the cost of a pathological line constant.
 */
export const FAILURE_LINE_SCAN_MAX = 8 * 1024;

/**
 * A stateless boolean match. The regexes here are module-level and SHARED, so a
 * `g` flag on any of them would make a bare `test()` advance `lastIndex` and
 * answer wrongly for every line after the first. Taking `test()` through this
 * one call keeps that whole class of bug to one line.
 */
function matches(re: RegExp, text: string): boolean {
  return re.test(text);
}

/** The classifier's view of one line: trimmed, and bounded by {@link FAILURE_LINE_SCAN_MAX}. */
function scanWindow(line: string): string {
  const t = line.trim();
  return t.length > FAILURE_LINE_SCAN_MAX ? t.slice(0, FAILURE_LINE_SCAN_MAX) : t;
}

/** Split a combined stream into lines: `\r\n`, `\r` and `\n` are all breaks. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * True when `line` reports a stage passing. Leading/trailing whitespace ignored;
 * a line that is only whitespace is not a success line (it is nothing).
 *
 * The failure arm is asked FIRST and both arms go through {@link matches}: a
 * `test()` on a module-level regex is stateless only while that regex has no `g`
 * flag, and a reader cannot see the flag from the call site, so routing every
 * boolean match in this module through one place means a flag change is fixed in
 * one place too.
 */
export function isSuccessLine(line: string): boolean {
  const t = scanWindow(line);
  if (t.length === 0) return false;
  if (matches(NONZERO_FAILURE_COUNT, t)) return false;
  return matches(SUCCESS_LINE, t);
}

/**
 * The harness's wrapper around a failing verify run —
 * `verify command `cmd` failed in <cwd>[: <stream>]`.
 *
 * Two rules, both from #1762:
 *
 *   - The wrapper itself is never a failure line. #1667's corrective-round
 *     exemption depends on this staying UNclassified when nothing behind it
 *     does: the harness saying a run exited non-zero is not a line of the
 *     gate's output naming a failure, and the whole no-assertion suite
 *     (`… failed in <cwd>: something went wrong` earns no round) rests on that.
 *   - What sits BEHIND the wrapper is classified normally, so a TAP, pytest or
 *     `✗` line wrapped by the harness reports what it reports unwrapped. The
 *     first version of this used the inner stream only as an existence veto and
 *     then matched the WHOLE wrapped line against the table, which silently
 *     dropped every anchored shape (`^✗\s`, `^ERROR \S+::`, `^--- FAIL:`) and
 *     let the loose `named-file` rule classify the wrapper's own prose.
 *
 * What the builder actually emits, read from the call site that composes it
 * (`work-driver-verify-per-worktree.ts`, which calls `formatExecError` with
 * `failMsg = "verify command \`<cmd>\` failed in <cwd>" + depsHint`, and the
 * helper then appends the extracted tail after `: ` — and a stream that spans
 * several lines may carry no `: ` at all. So a candidate is the builder's `: `
 * OR the first line break after `failed in`, and one is chosen as soon as what
 * follows it reports a failure — EXCEPT the separators that sit inside the deps
 * hint, which is why {@link depsHintStartFor} exists rather than a bare scan: a
 * hint whose problem text reads `hook failed during provisioning: Cannot find
 * module 'x'` is the harness's own diagnosis, and cutting inside it promotes
 * that diagnosis to "the gate's output", which is the #1667 suppression made
 * backwards. The ONE separator inside the hint that stays a candidate is the
 * hint's own `: ` — `formatExecError` appends the gate's tail after the whole
 * `failMsg` including the hint, so that is where the builder's separator sits. With a clean gate output no candidate reports a failure and the
 * wrapper stays unclassified (#1667's exemption), and with a hint that carries
 * its own `: ` the earlier cut yields a stream whose first lines carry no
 * failure, so the scan moves on. Cutting at the LAST `: ` instead would make a
 * hinted line report no failure at all, because the tail after the hint's colon
 * is a single line. tehas's
 * `…failed in /w: test.sh: failed checks (1)` still names its file.
 */
/** The harness sentence's own words, up to and including `failed in `. */
const HARNESS_PROSE = /^verify command\s.+?\sfailed in\s/i;
/** The builder's stream separator, and its width — the offset a cut skips. */
const STREAM_SEPARATOR = ": ";
const STREAM_SEPARATOR_LEN = STREAM_SEPARATOR.length;

/**
 * Where this line's deps hint begins, or `undefined` when it carries none.
 *
 * The hint is what `provisionDepsHint` appends to the harness's own sentence
 * before `formatExecError` appends the gate's tail, and each of its shapes
 * opens with one of `DEPS_HINT_STARTS` — the same phrase list
 * `work-driver-cause-scrub.ts` strips, so the cut and the scrub agree on what
 * the hint is instead of each guessing.
 *
 * EXPORTED because the reader that must not mistake the harness's diagnosis for
 * the gate's output is a different function from the one that cuts: a wrapper
 * whose hint says `hook failed during provisioning: Cannot find module 'x'`
 * would otherwise answer "the stream is `Cannot find module 'x'`" — the hint's
 * own problem text presented as a failure the gate printed, which is what makes
 * `depsHintApplies` keep a hint that #1667 exists to suppress.
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
 * The harness's own wrapper sentence, recognised. Exported so every reader
 * agrees on what a wrapper IS: `work-driver-verify-record.ts` used to keep its
 * own copy of this regex, and a reader that disagrees about the wrapper
 * disagrees about which lines a developer can act on.
 */
export function isHarnessWrapper(line: string): boolean {
  return HARNESS_PROSE.test(line);
}

/**
 * How many candidate separators one wrapper line is scanned for. The builder
 * appends exactly ONE stream separator and at most one line break, and the deps
 * hint can add a couple of its own, so the real candidate set is tiny; the cap
 * is what makes a pathological 8 KiB of `: ` inside a command string cost a
 * constant.
 */
const STREAM_CANDIDATES_MAX = 16;

/**
 * Every offset in `line` at or after `from` where the builder could have put
 * the stream, in order: the `: ` it appends, and the newline that separates the
 * harness sentence from a multi-line tail.
 */
function streamSeparators(line: string, from: number): number[] {
  const candidates: number[] = [];
  const push = (at: number): void => {
    if (at !== -1 && (candidates.length === 0 || candidates[candidates.length - 1] !== at)) {
      candidates.push(at);
    }
  };
  for (let at = line.indexOf(STREAM_SEPARATOR, from); at !== -1; ) {
    push(at);
    if (candidates.length >= STREAM_CANDIDATES_MAX) break;
    at = line.indexOf(STREAM_SEPARATOR, at + STREAM_SEPARATOR.length);
  }
  const brk = /\r\n|\r|\n/.exec(line.slice(from));
  if (brk !== null) push(from + brk.index);
  return candidates;
}

/**
 * Where the gate's own output begins inside a harness line, or `undefined`
 * when the line is not the harness's wrapper. `""` means the wrapper carries
 * no stream that reports a failure — it asserts only that a run exited
 * non-zero, which is not a line of the gate's output naming anything.
 */
function harnessVerifyStream(line: string): string | undefined {
  const matched = HARNESS_PROSE.exec(line);
  if (matched === null) return undefined;

  // The prefix is anchored and matched against the same trimmed line, so
  // `failed in ` sits at a fixed offset from the start: everything before it is
  // the wrapper's own wording, never the gate's.
  const afterFailedIn = matched[0].length;
  // Where the harness's own diagnostic begins, when the run carried one. Every
  // separator from there on belongs to the hint — EXCEPT the hint's own `: `, on
  // which `formatExecError` appended the gate's tail: that is the builder's
  // separator and the only cut that reaches a multi-line tail sitting behind a
  // hint. Treating it as hint text too would make a hinted wrapper report no
  // failure at all, which is the opposite defect from the one it prevents.
  const hintAt = depsHintStartFor(line);
  const hintColon =
    hintAt === undefined ? -1 : line.indexOf(STREAM_SEPARATOR, hintAt + STREAM_SEPARATOR_LEN);
  // Each candidate is a separator the builder could have appended. Everything
  // before the chosen one belongs to the command, the cwd or the deps hint — all
  // three may legitimately contain a colon or a newline.
  for (const at of streamSeparators(line, afterFailedIn)) {
    if (hintAt !== undefined && at >= hintAt && at !== hintColon) continue;
    // The separator is a `: ` or a line break, so its width is either two or
    // three — measure it rather than assume, or a newline cut leaks an `r`.
    const width = line.startsWith(STREAM_SEPARATOR, at)
      ? STREAM_SEPARATOR_LEN
      : line[at] === "\r" && line[at + 1] === "\n"
        ? 2
        : 1;
    // Bounded before it is classified: the candidates run to the end of the
    // line, so without this the "one line, one scan window" guarantee would
    // hold for the line and not for what sits after a late separator.
    const stream = line
      .slice(at + width, Math.min(at + width + FAILURE_LINE_SCAN_MAX, line.length))
      .trim();
    if (stream.length > 0 && classifyStream(stream) !== undefined) return stream;
  }
  return "";
}

/** The first classified line of a stream, whole-line first, then line by line. */
function classifyStream(stream: string): FailureLine | undefined {
  return classifyFailureLine(stream) ?? firstInnerFailure(stream);
}

/**
 * Classify one line. `undefined` when the line neither reports a failure nor
 * names one, and ALWAYS `undefined` for a line that reports success.
 */
export function classifyFailureLine(line: string): FailureLine | undefined {
  const t = scanWindow(line);
  if (t.length === 0 || isSuccessLine(t)) return undefined;
  // Ask about the gate's own output, not the wrapper around it: the wrapper is
  // never a failure line, and the first classified line behind it is the answer.
  const stream = harnessVerifyStream(t);
  if (stream !== undefined) return stream.length === 0 ? undefined : classifyStream(stream);
  for (const entry of SHAPES) {
    if (entry.re.test(t)) return { shape: entry.shape, namesTest: entry.namesTest };
  }
  return undefined;
}

/**
 * The first line of a wrapper-swallowed stream that reports a failure. The
 * stream may be several lines the wrapper swallowed (a per-worktree failure
 * string is one line of `… failed in <cwd>: <output>` where the output was
 * newline-flattened), so the first one that reports a failure is the answer,
 * and a passing tally cannot be rescued by a neighbour.
 */
function firstInnerFailure(stream: string): FailureLine | undefined {
  for (const raw of splitLines(stream)) {
    const inner = classifyFailureLine(raw);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/** The lines of `text` that report a failure, in stream order, trimmed. */
/**
 * The gate's own output behind a harness wrapper, or `undefined` when `line`
 * is not a wrapper. `""` means the wrapper carries no stream that reports a
 * failure.
 *
 * Exported for the readers that must judge WHAT the line says, not merely
 * whether it reports a failure: `extractSpecificAssertion` asks whether a line
 * is a `FAILED:` marker, and a marker wrapped by the harness is still a marker
 * — judging the wrapper instead lets the harness sentence be returned as "the
 * specific assertion" and spend the cycle's one corrective round (#798's
 * shape, revived through the wrapper). Same rule `classifyFailureLine` follows;
 * one owner for both.
 */
export function harnessInnerLine(line: string): string | undefined {
  return harnessVerifyStream(line.trim());
}

/** The lines of `text` that report a failure, in stream order, trimmed. */
export function failureLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (line.length > 0 && classifyFailureLine(line) !== undefined) out.push(line);
  }
  return out;
}
