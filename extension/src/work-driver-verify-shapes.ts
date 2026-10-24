/**
 * work-driver-verify-shapes — #1762: the failure-line TABLE, its shape entries,
 * and the success veto they all sit behind.
 *
 * Split out of `work-driver-verify-failures.ts` (AGENTS.md §12 file-size cap):
 * that module is the classifier — the wrapper read, the scan window, the one
 * entry point every verify reader asks — and this one is the DATA it consults:
 * the shape entries, their priority order, and the passing-line veto. The
 * direction is one-way (classifier → shapes); nothing here calls back into the
 * classifier, which is what keeps the module graph a DAG.
 *
 * THE ONE RULE THIS MODULE OWNS, and the one that was a real defect: a line that
 * reports SUCCESS is never a failure line. `pack_release_test.sh: 36 cases, 0
 * failed` contains the substring `fail`, matched a naive `/error|fail/i`, and was
 * printed as the top evidence of a handoff while the runner's real
 * `failed checks (1)` block sat above it. So every classifier entry asks
 * {@link isSuccessLine} first, and a key that can also occur inside an ordinary
 * word is anchored (`^\s*ok\s+\d`, never `/ok/`).
 *
 * TWO shapes are exempt from that veto, and both for the same reason — a runner
 * prints a FAILING line carrying the counts it compared:
 *
 *   - the assertion mark (`✗ expected 0 failures`), the runner's failure glyph;
 *   - the payload-bearing marker (#1762,
 *     `FAILED: a_test.sh: expected 0 failures, got 3`).
 *
 * {@link matchPreVetoShapes} answers them; the classifier calls it BEFORE the
 * success veto and {@link matchShapes} after it. Two functions rather than one
 * list with a flag, because the ordering IS the contract and a reader must be
 * able to see it.
 */

import type { FailureLine, FailureShape } from "./work-driver-verify-failures.ts";
import { FAILED_MARKER_RE, payloadDetail } from "./work-driver-verify-marker.ts";

/** A table entry: a shape, whether it names a check, and how to recognise it. */
export interface ShapeEntry {
  shape: FailureShape;
  namesTest: boolean;
  /** A stateless test, taken through the classifier's {@link matches}-style call. */
  re: RegExp;
}

/**
 * The assertion-mark shape, hoisted so the ONE definition serves both the table
 * below and the pre-veto step. Two copies of `^\s*✗\s` — one the table answers
 * from, one the veto step asks — is a pair that can drift, and the drift is
 * silent: exempt one and forget the other and a `✗` line either loses its shape
 * or loses its exemption.
 *
 * The mark sits at the START of the line (after whitespace) and is the runner's
 * FAILURE glyph — `✓` is its passing one — so it is a stronger signal than any
 * tally the same line carries, which is why it is asked before the success veto.
 */
const ASSERTION_MARK_SHAPE: ShapeEntry = {
  shape: "assertion-mark",
  namesTest: true,
  re: /^\s*✗\s/,
};

/**
 * The table's regex form of the payload shape, derived from the ONE judge
 * ({@link payloadDetail}) instead of a second pattern: the table wants an
 * `entry.re` to test, and a regex spelled out here would be a second definition
 * of "which marker names an assertion" — precisely the drift the verify layer
 * exists to forbid. It agrees with the pre-veto arm by construction, since both
 * wrap the same function over the same line.
 */
const MARKER_PAYLOAD_RE: RegExp = {
  test: (line: unknown) => payloadDetail(String(line)) !== undefined,
} as unknown as RegExp;

/**
 * The `failed-marker` entry, hoisted so the ONE definition serves the table and,
 * through `isBareFailedMarker`, every veto site that used to keep its own blanket
 * `/^FAILED:/`. Two copies of that regex (one the table answers from, one the
 * veto asks) is a pair that drifts silently: exempt one and forget the other and
 * a payload marker either loses its shape or loses its exemption.
 */
const FAILED_MARKER_SHAPE: ShapeEntry = {
  shape: "failed-marker",
  namesTest: false,
  re: FAILED_MARKER_RE,
};

/**
 * The shape the pre-veto step answers for: the payload-bearing marker, the #1762
 * half of the marker dialect the table used to answer for only as a bare
 * filename. Its test is {@link payloadDetail}, the single judge of what the shape
 * is, so the shape and the bare/payload split cannot disagree.
 */
const ASSERTION_MARKER_SHAPE = {
  shape: "failed-marker-payload" as FailureShape,
  namesTest: true,
  re: MARKER_PAYLOAD_RE,
};

/**
 * The shapes asked BEFORE the success veto. A runner prints a failing assertion
 * with the count it compared against (`✗ expected 0 failures`, `✗ got 0 errors,
 * expected 3`, `FAILED: a_test.sh: expected 0 failures, got 3`), so the veto has
 * to come after these or the tally inside the assertion vetoes the line that
 * names the defect. The ordering stays sound for every other shape because these
 * are the only patterns in the table a line reports as its own VERDICT and can
 * also carry a zero count in: a passing tally (`36 cases, 0 failed`, `0 failed`,
 * `12 passed`) is never printed with a leading `✗` (the mark is the failure
 * glyph) and never carries a `FAILED: <path>: <assertion>` prefix, so no success
 * line reaches the table through them.
 */
export function matchPreVetoShapes(line: string): FailureLine | undefined {
  if (ASSERTION_MARK_SHAPE.re.test(line))
    return { shape: ASSERTION_MARK_SHAPE.shape, namesTest: ASSERTION_MARK_SHAPE.namesTest };
  if (ASSERTION_MARKER_SHAPE.re.test(line))
    return {
      shape: ASSERTION_MARKER_SHAPE.shape,
      namesTest: ASSERTION_MARKER_SHAPE.namesTest,
    };
  return undefined;
}

/**
 * The table, in priority order, asked AFTER the success veto. The bare
 * `failed-marker` and its count summary come first, then the assertion mark (a
 * line the pre-veto step already answered, kept here so the table is complete on
 * its own), then the driver's own tsc/cargo dialect, the project runner's tally
 * and the rest. The FIRST match wins, so the two pi-rukas literals (which a
 * generic rule also contains) sit ahead of `diagnostic`, and every
 * success-adjacent key is anchored. Three rules every key obeys:
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
export const SHAPES: ReadonlyArray<ShapeEntry> = [
  // `.pi/verify-cmd`'s smoke loop: payload marker first (it names a check, so it
  // wins the race), then the bare marker and its count summary.
  ASSERTION_MARKER_SHAPE,
  FAILED_MARKER_SHAPE,
  ASSERTION_MARK_SHAPE,
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
 * Lines that report SUCCESS. Checked before the table (except for the two shapes
 * {@link matchPreVetoShapes} answers): a passing tally is not a failure line,
 * whatever substring it contains. Every key is anchored or counted, because a
 * bare `/ok/` also matches book, token, lookup and OK — and every passing-tally
 * veto is conditional on the line carrying no NON-ZERO failure count
 * (`hasCountedTally` in the classifier), because a tally that reports both halves
 * (`1 failed, 3 passed`) is a failure.
 */
export const SUCCESS_LINE =
  /^\s*✓|^\s*ok\s|\b0\s+(?:failed|failures|errors|fail)\b|\b\d+\s+(?:passed|passed,)\b|^\s*PASS\b|^\s*PASS\s|:?\s*\d+\s+cases,\s*0\s+failed|\bfailed\s+checks?\s*\(\s*0\s*\)|\b0\s+(?:failed|failing)\s+checks?\b/i;
