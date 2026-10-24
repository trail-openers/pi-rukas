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
 *     an ordinary word is anchored (`^\s*ok\s+\d`, never /ok/). ONE shape is
 *     exempt: the runner's assertion mark, which {@link matchShape} asks BEFORE
 *     that veto because a failing assertion is printed with the count it expected
 *     (`✗ expected 0 failures`). See that function for why the exemption cannot
 *     admit a passing tally.
 *   - One line, one shape. The table is tried in priority order and the first
 *     match wins, so `not ok 3 - x` reports `not-ok` and never `ok`.
 *   - One line, ONE scan window. Every classifier entry clips its argument with
 *     {@link scanWindow} before any regex or scan sees it, and everything a
 *     classifier then calls (`harnessVerifyStream`, `classifyStream`, the
 *     wrapper's inner-line pass) works on THAT text, never the caller's
 *     unclipped line — so the bound is applied once, at the entry, and no scan
 *     in this module is quadratic in a line the gate printed whole. The bound is a
 *     ceiling on ONE text, and a candidate walk that produces sixteen cuts of that
 *     text pays the ceiling sixteen times, which is why `harnessVerifyStream` clips
 *     each cut it is about to judge rather than trusting its caller's window.
 *
 * `namesTest` is the stricter half of the answer — the line that carries a
 * specific assertion or a named check, which is what `extractSpecificAssertion`
 * and the corrective-round gate require. A bare `FAIL` tally does not name one,
 * and stays false so an honest absence still reports absence.
 */

import { type HarnessStream, harnessVerifyStream } from "./work-driver-verify-inner-line.ts";
import { splitLines } from "./work-driver-verify-support.ts";

/** The shape a line was recognised as. Stable strings: tests pin them. */
export type FailureShape =
  | "failed-marker"
  | "failed-marker-payload"
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
 * keeping a copy that can drift. The marker's INTERNAL grammar (bare vs
 * payload-bearing, the count summary, the tally count) lives in
 * `work-driver-verify-marker.ts`, the #1762 size split, and is re-exported through
 * this module so every reader keeps importing the failure-line vocabulary from ONE
 * place instead of keeping a private copy of it.
 */
export { FAILED_MARKER_RE } from "./work-driver-verify-marker.ts";

import { FAILED_MARKER_RE, isBareFailedMarker } from "./work-driver-verify-marker.ts";
import {
  SHAPES,
  SUCCESS_LINE,
  type ShapeEntry,
  matchPreVetoShapes,
} from "./work-driver-verify-shapes.ts";

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
 * #1762 — the marker predicates, re-exported so every veto site asks them through
 * the failure-line module it already imports. `work-driver-verify-assertion.ts` and
 * `work-driver-consolidation-classify.ts` replace their old blanket `/^FAILED:/`
 * with `isBareFailedMarker`, and the consolidated tally harvest asks
 * `scriptTallyCount`; a reader that imported them from a third module would be a
 * reader that could import a private copy instead.
 */
export { isBareFailedMarker, scriptTallyCount } from "./work-driver-verify-marker.ts";

/**
 * A NON-ZERO failure count in a status position: right after the file's colon
 * (`test.sh: 1 failed`), as the failing half of a comma-separated tally that starts
 * at that colon (`pack_release_test.sh: 36 cases, 1 failed`), or bare after
 * whitespace (`1 failed, 3 passed` at the head of a summary). `isSuccessLine` applies
 * its passing vetoes only when a line carries none of these — the passing half of a
 * tally does not cancel the failing half — and prose that merely uses the words
 * (`index.ts: not found, which is fine`) matches none of the three positions.
 *
 * Written WITHOUT a pattern that backtracks per candidate.
 *
 * The tally position used to be the branch `:[^\r\n]*,\s*[1-9]\d*\s+(?:failed|...)`:
 * a comma after a colon, then a non-zero count. The wildcard does not have to SEARCH
 * for that comma. For each colon the branch tries, only the comma CLOSEST to it can
 * complete the match it describes: any comma further out is preceded, inside the
 * wildcard's own space, by an earlier comma the wildcard could have stopped at, and a
 * run that has already passed a comma can never satisfy `\s*[1-9]\d*\s+failed`. So
 * the position is a conjunction over ONE anchored quantifier — a colon, a comma-free
 * run, a comma, then the count — which recognises exactly the same strings while its
 * inner quantifier is a single character class with no alternation to re-enter, and
 * costs linear in the text it scans. `\s` stays out of the run because whitespace
 * after the count is part of what the branch matches; the other two positions keep
 * their own direct patterns, so the conjunction never widens the contract.
 *
 * Measured: the `:[^\r\n]*,` form cost 16 ms on an 8 KiB line of `": "` — one
 * backtracking step per separator — against 0.05 ms here, and the classifier asks it
 * once per candidate cut, so sixteen candidates turned a constant bound into 240 ms
 * (#1762 CI failure).
 */
function hasCountedTally(text: string): boolean {
  if (
    /:\s*[1-9]\d*\s+(?:failed|errors?|failures?)\b|(?<![\d.])[1-9]\d*\s+(?:failed|errors?|failures?)\b/i.test(
      text,
    )
  )
    return true;
  return /:[^,\r\n\s]*,\s*[1-9]\d*\s+(?:failed|errors?|failures?)\b/i.test(text);
}

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
 * THE cut half of the TWO-STAGE ORDER the classifier runs in, stated once here
 * because both halves are only visible from this file:
 *
 *   1. **The cut is decided over the FULL line, with a bounded walk.** Where a
 *      harness wrapper ENDS is a fact about the wrapper, not about how much text a
 *      judge may read, so {@link harnessVerifyStream} is asked over the unclipped
 *      line; its own scan is bounded by `separatorScanWindow` in
 *      `work-driver-verify-inner-line.ts`, which is what keeps that decision
 *      constant-time on a pathological line.
 *   2. **The table judges the CLIPPED gate stream.** What the cut returned — the
 *      gate's own text, already past the wrapper — is clipped by this function and
 *      only that text reaches {@link matchShape} and everything it calls, including
 *      each line of {@link firstInnerFailure}.
 *
 * So the clip is applied ONCE per text, to the stream the gate printed, and no scan
 * in this module is quadratic in a line the gate printed whole. Two properties make
 * that safe rather than a silent truncation:
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
  if (hasCountedTally(t)) return false;
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
  // The cut is asked over the UNCLIPPED line: where the wrapper ENDS is a fact about
  // the wrapper, not about how much text a judge may read. Deciding it from the clip
  // made a wrapper whose command string runs past the window answer "not a wrapper",
  // and the table then judged the harness's own prose. The scan window is the bound on
  // what the TABLE reads, and everything below is asked inside it.
  const found = harnessVerifyStream(line);
  if (found === undefined) {
    const t = scanWindow(line);
    return t.length === 0 ? undefined : matchShape(t);
  }
  if (found.stream.length === 0) return undefined;
  // The cut's stream is measured FROM the gate's first character, so a long harness
  // prefix can never consume the budget the report needs; clipping it here bounds the
  // table's scans without clipping away the report.
  const gate = scanWindow(found.stream);
  if (gate.length === 0) return undefined;
  return matchShape(gate) ?? firstInnerFailure(gate);
}

/**
 * The plain table - no wrapper logic: the assertion mark first, then the success
 * veto, then the remaining shapes in priority order, first match wins. This is
 * the NON-wrapper arm of {@link classifyFailureLine} and the single line every
 * wrapper path ends in; the argument must already be bounded, which both callers
 * guarantee.
 *
 * THE ONE EXCEPTION TO "ASK `isSuccessLine` FIRST" IS THE ASSERTION MARK. A
 * runner prints a FAILING assertion with the count it compared against
 * (`✗ expected 0 failures`, `✗ got 0 errors, expected 3`, `✗ there were 0
 * failures but should be 2`), so the success veto has to come AFTER that shape
 * or the tally inside the assertion vetoes the line that names the defect — the
 * exact #1762 symptom, arriving through the classifier rather than the store.
 * The ordering stays sound for every other shape because the mark is the only
 * pattern in the table that a line reports as its own VERDICT and can also carry
 * a zero count in: a passing tally (`36 cases, 0 failed`, `0 failed`, `12
 * passed`) is never printed with a leading `✗` — the mark is the runner's failure
 * glyph and `✓` is its passing one — so no success line reaches the table
 * through it.
 */
export function matchShape(line: string): FailureLine | undefined {
  if (line.length === 0) return undefined;
  // BEFORE the success veto, for the reason in the docblock above. The payload
  // marker joins the exemption because it has the SAME property, not because it
  // happens to sit first in the table: a gate prints a failing per-file marker
  // with the counts it compared (`FAILED: a_test.sh: expected 0 failures, got 3`),
  // and `isSuccessLine`'s `\b0\s+failed` / `N passed` arms would veto the one
  // line that names the defect — the #1762 symptom, arriving through the veto
  // step rather than the table. The exemption stays sound because the shape
  // requires a marker prefix AND an assertion token in the detail PAST the path:
  // a passing tally (`36 cases, 0 failed`, `0 failed`, `12 passed`) prints
  // neither, so no success line reaches the table through it. Both exemptions are
  // keyed to the shape object itself, so re-ordering SHAPES cannot re-veto one.
  const preVeto = matchPreVetoShapes(line);
  if (preVeto !== undefined) return preVeto;
  if (isSuccessLine(line)) return undefined;
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
 *
 * #1762 round 2 — EVERY inner line is clipped before the table sees it. The caller
 * clipped the STREAM, which bounds the whole `split`, but one inner line of that
 * stream can itself be a document (a serialized fixture diff, a JSON dump) and
 * `matchShape`'s `named-file` tally branch backtracks over every comma in it.
 * Clipping here is the same bound one level down, so no unclipped line reaches a
 * regex anywhere in this module.
 */
function firstInnerFailure(stream: string): FailureLine | undefined {
  for (const raw of splitLines(stream)) {
    const inner = matchShape(scanWindow(raw));
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
 * verbatim, with the harness's residue removed at the cut and the result clipped to
 * the scan window — see {@link scanWindow} for the two-stage order.
 */
export function harnessInnerLine(line: string): string | undefined {
  // The cut is asked over the UNCLIPPED line, for the classifier's own reason: the
  // wrapper's end is not a function of the judge's budget. The view is then clipped to
  // the same window the classifier judges, so reader and classifier cannot disagree.
  const found = harnessVerifyStream(line);
  if (found === undefined) return undefined;
  const view = scanWindow(found.stream);
  // An empty view is the same answer as no stream at all: a reader must never be shown
  // the harness's own sentence, which is the defect this window work exists to close.
  return view.length === 0 ? undefined : view;
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
