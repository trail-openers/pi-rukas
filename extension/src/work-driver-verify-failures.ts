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
 * `smoke-tests/lib/verify-loop.sh` matched none of them, so on project-runner v0.14.2
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
 *   - One line, ONE scan window. Every classifier entry clips its argument with
 *     {@link scanWindow} before any regex or scan sees it, and everything a
 *     classifier then calls (`harnessVerifyStream`, `classifyStream`, the
 *     wrapper's inner-line pass) works on THAT text, never the caller's
 *     unclipped line — so the bound is applied once, at the entry, and no scan
 *     in this module is quadratic in a line the gate printed whole.
 *
 * `namesTest` is the stricter half of the answer — the line that carries a
 * specific assertion or a named check, which is what `extractSpecificAssertion`
 * and the corrective-round gate require. A bare `FAIL` tally does not name one,
 * and stays false so an honest absence still reports absence.
 */

import {
  type HarnessStream,
  harnessVerifyStream,
} from "./work-driver-verify-inner-line.ts";
import { splitLines } from "./work-driver-verify-support.ts";

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
 * The exact marker `.pi/verify-cmd`'s smoke-test loop emits on failure
 * (`FAILED: <file>`, and its `FAILED: <n> test(s) — …` summary). Exported so the
 * three readers that must agree on what a marker IS — this table, the evidence-tail
 * anchor in `work-driver-exec-error.ts`, and the assertion veto in
 * `work-driver-consolidation-classify.ts` — share one regex rather than each
 * keeping a copy that can drift.
 */
export const FAILED_MARKER_RE = /^FAILED: .+$/;

/**
 * The harness's OWN kill/echo lines — `Command failed: …`, `Exit code: N`, the
 * driver's own `killed` verdict and an echoed `$ ` command. These are what the
 * executor prints when a run died; on a stream that says nothing else they are all
 * there is, so a last-resort reader may keep them. They are never evidence about
 * the project, so a recognised failure line always outranks them.
 *
 * EXPORTED (#1762 round 1) because a second reader kept its own copy of this list
 * and the two drifted: `work-driver-cause-class.ts` had the same words, and its
 * unanchored `killed` also vetoed any gate line that merely USED the word (a test
 * named `test-killed-child.ts: 1 failed` is a failure line, not the harness). The
 * `killed` branch is therefore anchored to the harness's own sentence — the whole
 * line, or the line opening with `killed by signal` — and a line about a killed
 * process is left to the table.
 */
export function isHarnessEchoLine(line: string): boolean {
  return /^\s*(?:Command failed:|Exit code:|\$\s|killed(?:\s+by\s+signal\b)?)/i.test(line);
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
  { shape: "failed-marker", namesTest: false, re: FAILED_MARKER_RE },
  // The loop's / biome's assertion mark — `✗`, never the passing `✓`.
  { shape: "assertion-mark", namesTest: true, re: /^✗\s/ },
  // The driver's own dialect: tsc, cargo rustc, and bare `error:`/`Error:` lines.
  {
    shape: "diagnostic",
    namesTest: true,
    re: /^error:?\s|^Error:|error\[E\d+\]|\bTS\d{4,}\b/,
  },
  // The project-runner shape: a script's own summary block naming its failing checks.
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

/** The classifier's view of one line: trimmed, and bounded by {@link FAILURE_LINE_SCAN_MAX}.
 *
 * THE entry bound for the whole module. `classifyFailureLine` clips here and
 * then hands ONLY this text to everything it calls, so no regex, `indexOf` or
 * `split` in this file — or in the inner-line reader it delegates to — ever sees
 * a character past the window. Two properties make that safe rather than a
 * silent truncation:
 *
 *   - **Monotone in the prefix.** Every classifier input is a whole-line match
 *     (`^…`/`$`-anchored or a token search) and every cut `harnessVerifyStream`
 *     can ACCEPT sits at or before the window's end, so clipping the tail can
 *     only drop candidates the table could not have matched inside the window
 *     anyway. A status keyword 8 KiB into one line is not a shape any runner
 *     prints, and the window's own test pins both halves: a real shape in the
 *     first 8 KiB still classifies, and one past it does not.
 *   - **Self-consistent offsets.** Because the caller clips, `harnessVerifyStream`
 *     no longer re-derives the window: the hint offsets, the candidate scan and
 *     every stream cut are measured in the SAME text, so there is exactly one
 *     bound and one coordinate space. The old shape clipped twice and still let
 *     the caller's full line reach `NONZERO_FAILURE_COUNT`, whose `[^\r\n]*`
 *     tally branch backtracks over every `: ` in it — measured 249 s on a 1 MB
 *     line, against 15 ms bounded. That is the cost this entry clip removes.
 *
 */
function scanWindow(line: string): string {
  const t = line.trim();
  return t.length > FAILURE_LINE_SCAN_MAX ? t.slice(0, FAILURE_LINE_SCAN_MAX) : t;
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
 * The harness's own wrapper sentence — owned by `work-driver-verify-inner-line.ts`
 * and re-exported here so every verify reader imports the failure-line vocabulary
 * from ONE module and cannot keep a private copy of it (the #1762 round-1 defect was
 * readers that disagreed about what a wrapper IS, and so disagreed about which lines
 * a developer may act on).
 */
export { isHarnessWrapper } from "./work-driver-verify-inner-line.ts";

/**
 * The gate's own view of one wrapper line (#1762 round 1).
 *
 * A line no longer than the scan window is answered from the cut's stream as it
 * stands: the caller's clip already covers it, and re-slicing would only re-derive a
 * fact the cut decided. A line LONGER than the window is re-read from where the
 * GATE'S OWN text begins, because clipping such a line at one window let the
 * wrapper's prefix — its command string, its cwd, its deps hint, all text the harness
 * wrote — consume the entire budget: a gate that printed an ordinary report behind a
 * long command string reported no failure at all, and the evidence named no failing
 * check. The re-anchored window is the same size, so a pathological line still costs
 * a constant; only its position moves, to where the truth is.
 */
function gateView(line: string, found: HarnessStream): string {
  const t = line.trim();
  if (t.length <= FAILURE_LINE_SCAN_MAX || found.streamStart < 0) return found.stream;
  return t.slice(found.streamStart, found.streamStart + FAILURE_LINE_SCAN_MAX);
}

/**
 * Classify one line. `undefined` when the line neither reports a failure nor
 * names one, and ALWAYS `undefined` for a line that reports success.
 *
 * Two steps, in this order: unwrap a harness wrapper (the wrapper is never a
 * failure line; what sits behind it is), then the plain table. The wrapper path
 * ends in {@link matchShape} on the already-cut stream, so it terminates by
 * construction: the stream is the gate's own text, and the cut never builds a new
 * stream out of one it has already built.
 */
export function classifyFailureLine(line: string): FailureLine | undefined {
  // The line is bounded ONCE, here, so no scan below can be quadratic in what the gate
  // printed whole. A line no longer than the window — every line a real harness
  // composes — is handed on UNCLIPPED.
  const t = scanWindow(line);
  if (t.length === 0) return undefined;
  // Ask about the gate's own output, never the wrapper around it: the wrapper is not a
  // failure line (#1667), and the first line behind it that reports a failure is the
  // answer. A line that is not a wrapper at all goes straight to the table.
  const found = harnessVerifyStream(line);
  if (found === undefined) return matchShape(t);
  if (found.stream.length === 0) return undefined;
  return matchShape(gateView(line, found)) ?? firstInnerFailure(gateView(line, found));
}

/**
 * The plain table - no wrapper logic: the success veto, then the shapes in
 * priority order, first match wins. This is the NON-wrapper arm of
 * {@link classifyFailureLine} and the single line every wrapper path ends in; the
 * argument must already be bounded, which both callers guarantee.
 */
export function matchShape(line: string): FailureLine | undefined {
  if (line.length === 0 || isSuccessLine(line)) return undefined;
  for (const entry of SHAPES) {
    if (entry.re.test(line)) return { shape: entry.shape, namesTest: entry.namesTest };
  }
  return undefined;
}

/**
 * The first line of a wrapper-swallowed stream that reports a failure. The
 * stream may be several lines the wrapper swallowed (a per-worktree failure
 * string is one line of `… failed in <cwd>: <output>` where the output was
 * newline-flattened), so the first one that reports a failure is the answer,
 * and a passing tally cannot be rescued by a neighbour. Calls {@link matchShape},
 * NOT {@link classifyFailureLine}: the stream is already the cut gate output, so
 * unwrapping it again would re-enter the cut for a line it has already judged.
 */
function firstInnerFailure(stream: string): FailureLine | undefined {
  for (const raw of splitLines(stream)) {
    const inner = matchShape(raw);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/**
 * The gate's own output behind a harness wrapper, or `undefined` when `line`
 * is not a wrapper. `""` means the wrapper carries no stream that reports a
 * failure.
 *
 * Exported for the readers that must judge WHAT the line says, not merely
 * whether it reports a failure: `extractSpecificAssertion` asks whether a line
 * is a `FAILED:` marker, and a marker wrapped by the harness is still a marker
 * - judging the wrapper instead lets the harness sentence be returned as "the
 * specific assertion" and spend the cycle's one corrective round (#798's
 * shape, revived through the wrapper). Same rule `classifyFailureLine` follows;
 * one owner for both, and one text: this is {@link harnessVerifyStream}'s cut
 * verbatim, with the harness's residue removed at the cut.
 */
export function harnessInnerLine(line: string): string | undefined {
  // The other entry into `harnessVerifyStream`, clipped to the same window and
  // re-anchored the same way, so the reader is shown exactly the text the classifier
  // judged and neither re-derives the other's view.
  const t = scanWindow(line);
  const found = harnessVerifyStream(t);
  return found === undefined ? undefined : gateView(line, found);
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
