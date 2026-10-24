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
  isHarnessWrapper,
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
  for (const line of lines) {
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
    // stays the only marker-shaped line that survives.
    if (isMarkerLine(candidate) && !isCountSummary(candidate)) continue;
    if (classifyFailureLine(candidate)?.namesTest === true) return redactedAssertion(candidate);
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
 */
export function sharesAssertion(consolidated: string, per: string): boolean {
  return per !== NO_SPECIFIC_ASSERTION && consolidated.includes(per);
}
