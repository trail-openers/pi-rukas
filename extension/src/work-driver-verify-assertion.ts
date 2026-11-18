/**
 * work-driver-verify-assertion — the line a verify failure NAMES as its
 * specific assertion, and the veto over lines that name nothing (#798/#807,
 * #1762).
 *
 * Split out of `work-driver-consolidation-classify.ts` along the natural seam
 * (AGENTS.md §12 file-size cap): that module's job is the THREE-WAY
 * classification of a consolidated-tree failure, and this is the reader it uses
 * to name the assertion. Both are the same text-level concern the failure-line
 * table feeds, so the pair stays together in the import graph, but only this
 * module answers "which line is the assertion" — and only this module decides
 * what a caller may be SHOWN as evidence.
 *
 * The three rules this seam owns, each of which was a real defect:
 *
 *   - **A marker is not an assertion.** `FAILED: smoke-tests/test-cancel.ts`
 *     names a FILE (#798 sent an operator to a filename and spent the cycle's
 *     one corrective round on it), and an echoed `$ …` line is a PASSING stage
 *     of the verify chain (#746 reported `$ cd extension && bun run check` as
 *     "the specific assertion"). Both are refused, and absence is reported as
 *     absence.
 *   - **A harness wrapper is never the assertion** — the line behind it is. The
 *     wrapper is prose the harness wrote, so returning it is #798 through a
 *     second door.
 *   - **What comes back is redacted.** Every field built from the extracted
 *     line reaches a human-visible surface (a corrective-round prompt, a
 *     handoff, a forge comment), and a failing assertion routinely ECHOES the
 *     value it compared.
 */

import { redactSecrets } from "./secret-patterns.ts";
import {
  FAILED_MARKER_RE,
  classifyFailureLine,
  harnessInnerLine,
  isBareFailedMarker,
  isCargoTargetSummaryLine,
  isHarnessWrapper,
  isLibtestVerdictLine,
  isLocationlessRustcDiagnostic,
  libtestVerdictForTest,
  rustPanicSamenessKey,
  rustPanicTestName,
} from "./work-driver-verify-failures.ts";

/**
 * #807 — the honest-absence sentinel. A tail with NO assertion-shaped line
 * (a bare `FAILED:` marker, an echoed command, a truncated stream) used to fall
 * back to the first non-empty line — which is exactly how #746 reported
 * `$ cd extension && bun run check` (an echoed, PASSING command) as "the
 * specific assertion". An explicit absence the operator can recognise beats a
 * confidently wrong specific; the tail is still shown next to it by
 * `consolidatedFailureMessage`.
 */
export const NO_SPECIFIC_ASSERTION = "(no specific assertion could be extracted)";

/**
 * #807 — a line that merely NAMES a failure, not an assertion: the smoke
 * loop's per-failure marker (`FAILED: smoke-tests/test-cancel.ts` — #798
 * reported this as the assertion, sending operators to a filename) and its
 * post-#804 summary (`FAILED: 2 test(s) — a.ts, b.ts`). The real assertion
 * sits beneath the marker; the summary carries the count.
 *
 * #1762 — this used to be a blanket `/^FAILED:/`, which vetoed the
 * payload-bearing form with the bare one. A gate that prints
 * `FAILED: test/a_test.sh: … expected '0', got '1'` as its ONLY line yielded no
 * assertion at all: every reader refused the line that named the defect, the
 * corrective round declined, and the cycle parked blind. The veto is now "the
 * table classifies this line as the BARE marker shape", which keeps #798 (a
 * filename is not an assertion) and lets the payload form through.
 */
const isMarkerLine = isBareFailedMarker;
/** #807 — an ECHOED shell command (the verify-cmd chain's `$ …` output, #746). */
const IS_ECHOED_COMMAND = /^\$ /;

/**
 * #807 — a token-shape secret guard: the extracted assertion reaches a
 * GitHub comment (cap evidence + handoff body), so a line that looks like
 * credential material is skipped in favour of the next qualifying line.
 */
const LOOKS_LIKE_SECRET =
  /(api[_-]?key|access[_-]?token|bearer\s|password|passwd|secret[_-]?key)\s*[=:]\s*\S{8,}/i;

/**
 * The credential-shaped veto, asked on its own by the count-summary predicate in
 * `work-driver-consolidation-classify.ts` — that reader KEEPS a marker-shaped line
 * the general veto refuses, so it needs the secret arm without the marker and echo
 * arms. One definition, so the two readers cannot disagree about what credential
 * material is.
 */
export function looksLikeCredential(line: string): boolean {
  return LOOKS_LIKE_SECRET.test(line);
}

/**
 * #807 — a line that is neither an assertion nor usable evidence.
 *
 * #1762 round 3 — EXPORTED. The same predicate must refuse the same text on
 * both routes into a developer prompt: `extractSpecificAssertion` applies it to
 * the line it judges, but it only ever judges a SINGLE-LINE stream, and
 * `work-driver-verify-record.ts` unwraps a multi-line stream itself — so
 * without one shared owner, a credential printed inside a harness wrapper was
 * offered as "an assertion the developer can act on" and reached the handoff
 * and the forge comment.
 */
export function isNonAssertionLine(line: string): boolean {
  return isMarkerLine(line) || IS_ECHOED_COMMAND.test(line) || LOOKS_LIKE_SECRET.test(line);
}

/**
 * #1762 — the line whose CONTENT decides whether `line` is an assertion, and
 * the line returned when it is. For a harness-wrapped failure
 * (`verify command `cmd` failed in <cwd>: <stream>`) that is the gate's own
 * line behind the wrapper, not the wrapper: a `FAILED:` marker is never a
 * specific assertion whether bare or wrapped, and the wrapper is prose the
 * harness wrote, so judging (or returning) it is exactly the #798 defect — an
 * operator sent to the harness sentence, and the cycle's one corrective round
 * spent on it. `undefined` when the wrapper carries no stream that reports a
 * failure, which is #1667's no-assertion exemption.
 *
 * Only a SINGLE-LINE stream is substituted. A multi-line stream is not one
 * line, and the caller is scanning line by line: substituting the whole stream
 * here would return harness wrapper text plus gate output as one "assertion".
 * `assertionLines` / `failureLines` reach every inner line separately. A
 * multi-line stream therefore yields `undefined` rather than the wrapper: the
 * wrapper is harness prose and can never be the answer, whether or not a line
 * beneath it is.
 */
function assertionCandidate(line: string): string | undefined {
  if (isMarkerLine(line)) return undefined;
  const inner = harnessInnerLine(line);
  // Not a wrapper, or a wrapper carrying no stream that reports a failure
  // (#1667's exemption, which `classifyFailureLine` also answers undefined for).
  if (inner === undefined || inner.length === 0) {
    // #1762 round 2 — a wrapper whose inner stream the reader refuses is NOT an
    // assertion. The wrapper is prose the harness wrote, and returning it is the
    // #798 defect arriving through this door: the operator is sent to the harness
    // sentence and the cycle's one corrective round is spent on it. Before the
    // window work this function fell back to the caller's line — which for a
    // wrapper IS the harness sentence. A line the caller handed that is not a
    // wrapper at all is still the caller's own line and is returned unchanged.
    return isHarnessWrapper(line) ? undefined : line;
  }
  if (inner.includes("\n")) return undefined;
  return inner;
}

/**
 * #1762 round 2 — the value the extractor returns, REDACTED. Every field built
 * from it reaches a human-visible surface: `verdict.assertion` is printed into
 * `consolidatedFailureMessage` and the classifier's `reason` strings, and
 * `gatePerAssertion` / `baselineRedMessage` quote the extracted line into a
 * corrective-round prompt, a handoff and a forge comment. A failing assertion
 * routinely ECHOES the value it compared, so a credential the gate printed rides
 * home in that field. The pre-existing `LOOKS_LIKE_SECRET` veto is
 * KEYWORD-shaped (`api_key = …`) and cannot name a bare token welded into prose
 * (`✗ token mismatch got ghp_…`), which is the shape a test failure actually
 * prints. `redactSecrets` is the arm that does — and it must run on the
 * UNCLIPPED line, which is why this is a bare redact and not `redactThenBound`:
 * a code-point clip that lands inside a token amputates the context the patterns
 * are anchored on, and a half-token survives every arm. The width bound is
 * applied once, at each reader that stores the line, by its own
 * `redactThenBound` — see `work-driver-verify-record.ts`.
 */
function redactedAssertion(candidate: string): string {
  return redactSecrets(candidate).text;
}

/**
 * #2341 — join a Rust panic header with its message line. libtest prints the
 * failing verdict as TWO lines — `thread 'NAME' panicked at FILE:LINE:` then
 * the message (`fast path took 101.409582ms, which is over the 100 ms bound`)
 * — and only the pair names the measured value and the bound the operator
 * needs; the header alone sent the nessie 1415 handoff hunting for a memory
 * problem while the decisive line sat in the same window. The message is
 * joined only when the header ends at its colon (the pre-1.73 single-line
 * form carries it inline) and the next line is still the message: a `note:`,
 * a `---- ` block separator, cargo's failing-test list (`failures:` and the
 * test-name line under it), another classified failure line, or a
 * marker/echo/secret-shaped line is NOT the message, and a half-pair is
 * returned as the header — it still names the test, file and line, which
 * beats reporting absence for a truncation the window caused. An empty
 * `lines[i + 1]` (the pair cut between the two lines) takes this same path.
 */
function joinedRustPanic(header: string, next: string | undefined): string {
  if (!header.endsWith(":")) return header;
  if (next === undefined) return header;
  // The `\S+::` arm is cargo's failing-test LIST: the block header `failures:`
  // and the test-name line printed beneath it. The caller hands lines in
  // trimmed, so the list item is matched in its bare `path::to::test` form —
  // the `\s*` prefix keeps the indented form refused too, wherever a caller
  // stops trimming.
  if (/^(note:|----|thread\s+'|failures:|\s*\S+::)/.test(next)) return header;
  if (isLibtestVerdictLine(next)) return header;
  if (isNonAssertionLine(next) || classifyFailureLine(next) !== undefined) return header;
  return `${header} ${next}`;
}

/**
 * Extract the specific failing assertion from a consolidated-verify failure
 * tail. The tail comes from `extractAttributedTail` — when `attributed:
 * true` it starts at a `FAILED:` marker (post-#804 the LAST one, the
 * summary, which is why a marker alone is never a valid answer); when
 * `false` it is the last 800 chars of the combined output (the biome/tsc
 * chain-stage shape, which emits no marker and may carry an echoed `$ …`
 * command line from a passing earlier stage).
 *
 * #807 — the assertion is the FIRST line of the tail that carries actual
 * failure content, preferring a `✗` assertion (smoke loop / biome /
 * scaffold), then any other line the shared failure-line table recognises as
 * naming a failure — a compiler/linter error, a TAP `not ok`, a pytest
 * `FAILED path::name`, a go `--- FAIL:`, or a script's `failed checks (N)`
 * block. Marker lines (`FAILED: …`,
 * including the `FAILED: <n> test(s) — …` summary), echoed shell command
 * lines (`$ …`), and secret-shaped lines are NEVER selected. When no line
 * qualifies, `NO_SPECIFIC_ASSERTION` is returned instead of the first
 * non-empty line (the #746 defect): a field that reports absence honestly
 * beats one that sometimes holds a filename and sometimes a command echo.
 *
 * Multi-failure (post-#804) decision, pinned in test-work-driver-verify-
 * extract-assertion.ts: "the specific assertion" is the FIRST real
 * assertion; the count is the summary marker's job, so it is not
 * duplicated into the extracted field.
 */
export function extractSpecificAssertion(failureTail: string): string {
  // `FAILED:` and its `FAILED: 1 test(s) — …` summary are ONE regex, and
  // `FAILED_MARKER_RE` demands a non-empty payload: an empty marker is not a
  // marker, it is an empty line, and it must not be kept as the count summary.
  const isCountSummary = (line: string): boolean =>
    /^FAILED:\s*\d+\s+test\(s\)/.test(line) && FAILED_MARKER_RE.test(line);
  const lines = failureTail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    const candidate = assertionCandidate(line);
    if (candidate === undefined || isNonAssertionLine(candidate)) continue;
    if (/^✗\s/.test(candidate)) return redactedAssertion(candidate);
  }
  for (const [i, line] of lines.entries()) {
    const candidate = assertionCandidate(line);
    if (candidate === undefined || isNonAssertionLine(candidate)) continue;
    // The count summary is the one BARE-marker-shaped line this reader KEEPS — the
    // marker veto below would otherwise drop it, and it carries the count.
    //
    // #1762 — the shape gate is `namesTest`, not "the table recognised something".
    // A bare marker that happens to carry a tally (`FAILED: 2 test(s) — …`) and a
    // marker whose detail is prose (`FAILED: a_test.sh: no such file`) are both
    // recognised, and both name NOTHING — they are filenames, which is #798
    // (an operator sent to a file, and the one corrective round spent there). Only
    // a line that names a check may be the specific assertion, so a bare marker
    // stays refused however it classifies, and the count-summary exception above
    // stays the only marker-shaped line that survives. #2341 adds the same veto on
    // shape: cargo's `error: test failed, to rerun pass --bin X` summary line is
    // recognised (`cargo-summary`) but names only the build target, never a check,
    // so a stream whose only recognised line is that summary reports ABSENCE — the
    // honest absence the #807 sentinel exists for — instead of quoting the least
    // useful line in the run as "the assertion". What this reader returns is
    // either a line that names a check, or the sentinel.
    if (isMarkerLine(candidate) && !isCountSummary(candidate)) continue;
    const kind = classifyFailureLine(candidate);
    if (kind?.namesTest !== true) continue;
    if (kind.shape === "rust-panic") {
      // #2341 round 1 — the `#[should_panic]` veto. A panic header is only
      // evidence of a FAILING test when the window attributes a FAILING
      // verdict to THAT test: libtest prints a passing `#[should_panic]`
      // test's captured stdout in the identical shape, so in a run that
      // exited non-zero for some OTHER reason (a later `make` stage, a lint
      // stage, or — #2341 fix wave H1 — a genuinely failing test whose
      // verdict made the WINDOW look failing) this line names a test that
      // PASSED. Quoting it as "the specific assertion" is the #746/#798 class
      // the module's own doctrine forbids — a confident wrong answer where an
      // honest absence was the truth — and a classified line can earn the
      // cycle's one corrective round, while its header-as-sameness-key then
      // excuses the change-added failure. `undefined` (no verdict observed at
      // all — a truncated window, a single-line fixture) vetoes nothing: an
      // absent observation is not a verdict either way. ONE predicate with the
      // evidence-anchor walk, which asks the same veto before letting a header
      // own the anchor — see `work-driver-exec-error.ts`.
      if (libtestVerdictForTest(lines, rustPanicTestName(candidate)) === false) continue;
      return redactedAssertion(joinedRustPanic(candidate, lines[i + 1]));
    }
    return redactedAssertion(candidate);
  }
  return NO_SPECIFIC_ASSERTION;
}

/**
 * #807 — true when `per` is a genuine assertion that also appears verbatim
 * in `consolidated`, for the classifier's root-cause match. Extracted
 * assertions are compared (the #798 fix): both sides reduced to a marker
 * or an echo used to make a marker-vs-marker match (or a marker-vs-text
 * miss) where the identical `✗ …` line sat invisibly underneath. The
 * sentinel never matches — absence on either side is not evidence of a
 * shared cause.
 *
 * #2341 — sameness FAILS CLOSED on cargo's TARGET-LEVEL lines. Every failing
 * test in one cargo target prints the byte-identical `error: test failed, to
 * rerun pass --bin X` line, and cargo's other
 * run-level summaries (`process didn't exit successfully`, `N target(s)
 * failed`, `could not compile`) are equally identical across the different
 * failures inside the target — so substring containment on any of them claims
 * "the SAME assertion" between two genuinely different Rust test failures, and
 * `baselineExplainsChange` excuses a regression the change itself introduced.
 * The extractor can no longer produce such an assertion (the `cargo-summary`
 * shape is `namesTest: false`), but this reader is the sameness gate for
 * hand-built values too, so it refuses cargo's target-level dialect wherever it
 * arrives from — the SAME predicate the table's entry asks, not a copy of it.
 *
 * #2341 — and a Rust panic compares on its IDENTITY, never on the joined
 * prose: `rustPanicSamenessKey` reduces the assertion to the
 * `thread '<test>' panicked at <file>:<line>:<col>:` header, which is the
 * part that distinguishes failing tests (the message carries the measured
 * value, which legitimately differs run to run, and a clip can amputate it —
 * sameness anchored on a clipped prose prefix folds). The key FAILS CLOSED
 * (#2341 fix wave M1): a string that starts like a panic header but whose
 * identity could not be extracted answers `null`, and `null` is no "SAME
 * assertion" — it never reaches the containment test. Every other shape
 * keeps the classic rule: exact containment, no normalisation — this gate
 * got tighter for #2341, and tightening it is the whole point of the fix.
 *
 * #2341 fix wave (H2) — and the location-less rustc-code dialect is refused
 * the same way the cargo target summaries are: two compile failures in
 * different files print the byte-identical `error[E0308]: …` line (cargo
 * puts the location on the following `-->` line), so containment on it
 * claims "the SAME assertion" between two genuinely different failures.
 */
export function sharesAssertion(consolidated: string, per: string): boolean {
  if (
    per === NO_SPECIFIC_ASSERTION ||
    isCargoTargetSummaryLine(per) ||
    isLocationlessRustcDiagnostic(per)
  ) {
    return false;
  }
  const key = rustPanicSamenessKey(per);
  return key !== null && consolidated.includes(key);
}
