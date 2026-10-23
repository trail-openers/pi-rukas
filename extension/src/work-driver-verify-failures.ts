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
 * `smoke-tests/lib/verify-loop.sh` matched none of them, so on orchard v0.14.2
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
 * contains) sit ahead of `diagnostic`, and every success-adjacent key is anchored.
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
  // The orchard shape: a script's own summary block naming its failing checks.
  {
    shape: "script-tally",
    namesTest: true,
    re: /[\w./-]+\.(?:sh|bash|py|js|ts|go|rs)\s*:\s*(?:failed|failing)\s+checks?\s*\(\s*[1-9]\d*\s*\)/i,
  },
  // A script/file line that says it failed. `isSuccessLine` is what keeps the
  // passing tally (`36 cases, 0 failed`) out of this rule.
  {
    shape: "named-file",
    namesTest: true,
    re: /[\w./-]+\.(?:sh|bash|py|js|jsx|ts|tsx|mjs|go|rs|rb|java|c|cpp|kt)\b.*\b(?:failed|failing|FAIL\b|error\b|cannot|not found)/i,
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
 * because a bare `/ok/` also matches book, token, lookup and OK.
 */
const SUCCESS_LINE =
  /^\s*✓|^\s*ok\s|\b0\s+(?:failed|failures|errors|fail)\b|\b\d+\s+(?:passed|passed,)\b|^\s*PASS\b|^\s*PASS\s|:?\s*\d+\s+cases,\s*0\s+failed/i;

/** Split a combined stream into lines: `\r\n`, `\r` and `\n` are all breaks. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * True when `line` reports a stage passing. Leading/trailing whitespace ignored;
 * a line that is only whitespace is not a success line (it is nothing).
 */
export function isSuccessLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  return SUCCESS_LINE.test(t);
}

/**
 * The harness's own wrapper around a failing verify run —
 * `verify command `cmd` failed in <cwd>: <stream>` (#1667's corrective-round
 * exemption depends on this line staying UNclassified when nothing behind it
 * does: the harness saying a run exited non-zero is not a line of the gate's
 * output naming a failure, and pre-#1767 the whole suite of no-assertion cases
 * rests on that). The stream is what follows the first `: `; a stream that
 * itself carries a failure line is still classified, so orchard's
 * `…failed in /w: test.sh: failed checks (1)` names its file (#1762).
 */
const HARNESS_VERIFY_PREFIX = /^verify command\s.*?\sfailed in\s[^:]+:\s*/i;

/** True when the line is the harness's wrapper around the gate's own output. */
function isHarnessVerifyLine(line: string): boolean {
  return HARNESS_VERIFY_PREFIX.test(line);
}

/**
 * Classify one line. `undefined` when the line neither reports a failure nor
 * names one, and ALWAYS `undefined` for a line that reports success.
 */
export function classifyFailureLine(line: string): FailureLine | undefined {
  const t = line.trim();
  if (t.length === 0 || isSuccessLine(t)) return undefined;
  // Ask about the gate's own output, not the wrapper around it. A line that is
  // ONLY the wrapper says nothing beyond "a run exited non-zero".
  if (isHarnessVerifyLine(t)) {
    const stream = t.replace(HARNESS_VERIFY_PREFIX, "").trim();
    if (stream.length === 0) return undefined;
    // A stream may itself be several lines the wrapper swallowed (a per-worktree
    // failure string is one line of `… failed in <cwd>: <output>` where the
    // output was newline-flattened): ask if the whole tail or any single line of
    // it reports a failure, so a passing tally cannot be rescued by a neighbour.
    if (
      classifyFailureLine(stream) === undefined &&
      splitLines(stream).every((l) => classifyFailureLine(l) === undefined)
    )
      return undefined;
  }
  for (const entry of SHAPES) {
    if (entry.re.test(t)) return { shape: entry.shape, namesTest: entry.namesTest };
  }
  return undefined;
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
