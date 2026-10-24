/**
 * work-driver-verify-marker — the `FAILED:` marker split: what a marker is, what
 * makes one payload-bearing, and the two predicates every veto site asks instead
 * of the old blanket `/^FAILED:/` (#1762).
 *
 * Split out of `work-driver-verify-failures.ts` along the natural seam (AGENTS.md
 * §12 file-size cap): that module's job is the ONE TABLE of failure-line shapes
 * and the wrapper read; this one owns the marker's internal grammar — path,
 * detail, count summary, bare/payload — which is a smaller question with its own
 * invariants. The table module imports these symbols and passes the payload test
 * INTO its shape entry, so the direction stays table → marker and no cycle closes.
 *
 * The defect this closes. `IS_MARKER_LINE = /^FAILED:/` vetoed EVERY `FAILED:`
 * line, so the line that actually names an assertion —
 * `FAILED: test/a_test.sh: a first run writes the settings: expected '0',
 * got '1'` — was refused by the same predicate that refuses a bare filename. A
 * worktree whose gate printed only that line yielded no assertion line, the
 * corrective round declined, and the cycle parked blind while the evidence sat in
 * the failure text.
 */

/** The marker's own dialect: `FAILED: <payload>` with a non-empty payload. */
export const FAILED_MARKER_RE = /^FAILED: .+$/;

/**
 * The marker form that is a SCRIPT'S TALLY rather than a per-file verdict:
 * `FAILED: 2 test(s) — a.ts, b.ts`. It carries a COUNT and a name list, so it is
 * NEVER the payload shape; the count-summary readers keep it explicitly.
 */
const FAILED_COUNT_SUMMARY_RE = /^FAILED:\s*\d+\s+test\(s\)/;

/**
 * The payload of a `FAILED: <path>: <detail>` marker, captured from the FIRST
 * `: ` that follows the path. The marker's dialect (`FAILED: <file>`) puts no
 * whitespace in `<path>`, so that first `: `-with-space is always the path/detail
 * boundary — and a real detail carries colons of its own (`a first run writes the
 * settings: expected '0', got '1'`), which is why the token is searched for only
 * in the capture and never in the whole line.
 *
 * PRECONDITION: a SINGLE trimmed line. A path that contains whitespace (`FAILED:
 * my test/a test.sh: expected 0, got 1`) is not recognised as such — `\S+` cannot
 * span the space, so the whole line reads as a BARE marker and no detail is
 * captured. Passing a multi-line stream is likewise meaningless: the regexes are
 * anchored per call and `.` does not cross a line break, so at most the first
 * line is ever judged.
 */
const MARKER_DETAIL_RE = /^FAILED: \S+: (.+)$/;

/**
 * The words an assertion payload reports with. Word boundaries for the words
 * (`asserted` is prose, `assert` is a check) and none for the operators, which
 * carry no word characters of their own. Asked ONLY on the detail half of a
 * marker — a token inside the PATH half (`FAILED: 2 test(s) — error.ts, got.ts`)
 * is part of a filename and never makes a line payload-bearing.
 */
const ASSERTION_TOKEN_RE = /\b(?:expected|got|assert|error)\b|!==|===|\bto equal\b|\bto be\b/i;

/**
 * The assertion-bearing detail of a marker, or `undefined` when it has none. THE
 * single judge of the payload shape, asked by the table's shape entry, by
 * {@link isBareFailedMarker} and by the classifier's pre-veto exemption — so the
 * shape, the veto and the bare/payload split cannot disagree on what counts. The
 * count-summary form is refused FIRST: its "detail" is a name list, so a filename
 * that happens to read like a token must not promote it.
 */
export function payloadDetail(line: string): string | undefined {
  const t = line.trim();
  if (FAILED_COUNT_SUMMARY_RE.test(t)) return undefined;
  const m = MARKER_DETAIL_RE.exec(t);
  const detail = m?.[1];
  if (detail === undefined || detail.length === 0) return undefined;
  return ASSERTION_TOKEN_RE.test(detail) ? detail : undefined;
}

/**
 * True when `line` is the BARE per-file marker — a payload, but no named
 * assertion. Every veto site that used to ask a blanket `/^FAILED:/` asks this
 * instead (#1762): the blanket vetoed the payload-bearing form with it, which is
 * how a worktree whose gate printed
 * `FAILED: test/a_test.sh: … expected '0', got '1'` parked blind and spent the
 * cycle's one corrective round on nothing. The count summary is NOT bare (it is
 * the tally form, kept explicitly by the count-summary readers); a marker whose
 * detail carries no assertion token IS bare.
 *
 * PRECONDITION: a SINGLE trimmed line — both predicates trim before matching, so
 * leading/trailing whitespace costs nothing, but a multi-line stream is judged as
 * its first line only and a path containing whitespace reads as a bare marker.
 */
export function isBareFailedMarker(line: string): boolean {
  const t = line.trim();
  if (!FAILED_MARKER_RE.test(t)) return false;
  if (FAILED_COUNT_SUMMARY_RE.test(t)) return false;
  return payloadDetail(t) === undefined;
}

/**
 * The N of a script's tally line — `test.sh: failed checks (2), not run (0)` →
 * `2`. The ONE count reader, exported so the consolidated tally harvest in
 * `work-driver-verify-record.ts` asks it rather than spelling the regex a second
 * time — the same one-reader rule the rest of the verify layer keeps.
 */
export function scriptTallyCount(line: string): number | undefined {
  const m = /\bfailed\s+checks?\s*\(\s*(\d+)\s*\)/i.exec(line.trim());
  if (m === null) return undefined;
  const n = Number(m[1]);
  // A count that is not a safe integer is not a count: `Number.isFinite` would let a
  // 400-digit numeral through as a float, and the harvest's `count - names.length`
  // then discloses an omitted figure that never was a tally.
  return Number.isSafeInteger(n) ? n : undefined;
}
