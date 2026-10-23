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
  // The orchard shape: a script's own summary block naming its failing checks.
  {
    shape: "script-tally",
    namesTest: true,
    re: /[\w./-]+\.(?:sh|bash|py|js|ts|go|rs)\s*:\s*(?:failed|failing)\s+checks?\s*\(\s*[1-9]\d*\s*\)/i,
  },
  // A script/file line that says it failed, in one of the four shapes a runner
  // actually prints: `<file>: failed|FAILED|FAIL|ERROR`, `<file> … FAILED`,
  // `<file>: N failed|N errors` with N >= 1, and a leading `FAIL <file>`.
  // Prose that merely contains the word error, `cannot` or `not found`
  // (`index.ts: fatal error`, `index.ts: cannot parse`,
  // `src/a.ts: consider this error case`) is NOT one of them — it names no
  // failed check, and classifying it would make that prose the anchor. The
  // The status must sit DIRECTLY after the file's colon (`:\s*`, never a lazy
  // `.*?`): `index.ts: fatal error` puts a word between them, so `error` there
  // is prose, not the status the line reports. The `(?<=\s)FAILED(?=\W|$)`
  // branch is the `<file> … FAILED` shape (go's `foo_test.go  FAILED`), and
  // `:\s*[1-9]…` the counted tally, whose zero case `isSuccessLine` settles.
  {
    shape: "named-file",
    namesTest: true,
    re: /^\s*FAIL\s+[\w./-]+\.(?:sh|bash|py|js|jsx|ts|tsx|mjs|go|rs|rb|java|c|cpp|kt)\b/i,
  },
  {
    shape: "named-file",
    namesTest: true,
    re: /[\w./-]+\.(?:sh|bash|py|js|jsx|ts|tsx|mjs|go|rs|rb|java|c|cpp|kt)\b\s*(?::\s*(?:failed|failing|fail|error)\b|(?<=\s)FAILED(?=\W|$)|:\s*[1-9]\d*\s+(?:failed|errors?|failures?\b))/i,
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
 * helper then appends the extracted tail after `: `). Two things vary and both
 * break a naive prefix strip: the command is a shell line that can itself
 * contain `&&` and colons, and `depsHint` (`provisionDepsHint`) is prose that
 * can contain `: ` — the `hook-failed` shape ends `… during provisioning: <problem>`.
 * So the cut is made at the FIRST `: ` at or after a `: ` whose tail reports a
 * failure: with a clean gate output the candidate set is empty and the wrapper
 * stays unclassified (#1667's exemption), and with a hint that carries its own
 * `: ` the earlier cut yields a stream whose first lines carry no failure, so
 * the scan moves to the real separator. Cutting at the LAST `: ` instead would
 * make such a line report no failure at all, because the tail after the hint's
 * colon is a single line. orchard's
 * `…failed in /w: test.sh: failed checks (1)` still names its file.
 */
const HARNESS_VERIFY_PREFIX = /^verify command\s.+?\sfailed in\s/i;

/** The builder's stream separator. */
const STREAM_SEPARATOR = ": ";

/**
 * Where the gate's own output begins inside a harness line, or `undefined`
 * when the line is not the harness's wrapper. `""` means the wrapper carries
 * no stream that reports a failure — it asserts only that a run exited
 * non-zero, which is not a line of the gate's output naming anything.
 */
function harnessVerifyStream(line: string): string | undefined {
  const matched = HARNESS_VERIFY_PREFIX.exec(line);
  if (matched === null) return undefined;
  // The prefix is anchored and matched against the same trimmed line, so
  // `failed in ` sits at a fixed offset from the start: everything before it is
  // the wrapper's own wording, never the gate's.
  const afterFailedIn = matched[0].length;
  // Each candidate is a `: ` that follows `failed in`. Everything before the
  // chosen one belongs to the command, the cwd or the deps hint — all three may
  // legitimately contain a colon.
  const candidates: number[] = [];
  for (let at = line.indexOf(STREAM_SEPARATOR, afterFailedIn); at !== -1; ) {
    candidates.push(at);
    at = line.indexOf(STREAM_SEPARATOR, at + STREAM_SEPARATOR.length);
  }
  for (const at of candidates) {
    const stream = line.slice(at + STREAM_SEPARATOR.length).trim();
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
  const t = line.trim();
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
export function failureLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (line.length > 0 && classifyFailureLine(line) !== undefined) out.push(line);
  }
  return out;
}
