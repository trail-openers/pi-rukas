import type { Severity } from "./lens-review-format.ts";

/**
 * lens-severity-rubric — what a severity label has to be worth (#1992 line).
 *
 * Two halves, both harness-side, because the lens skills cannot be trusted to
 * police themselves: the four uncalibrated ladders (simplicity, type-safety,
 * architecture, security) define HIGH by an adjective — "significant", "could
 * lead to", "impedes maintenance" — which a model can satisfy for almost any
 * finding it bothers to report. In one six-lens pass over a 7-file
 * offline-script PR, 49 of 56 findings were labelled HIGH and about two were
 * real: 17 simplicity, 13 type-safety, 9 security, 8 architecture. error-handling
 * and performance were calibrated (they anchor HIGH to production incidents),
 * and the blocking bar is moving to HIGH, so an inflated label is now a fix order.
 *
 * `SEVERITY_RUBRIC` is the floor on the EVIDENCE a HIGH requires, printed in the
 * lens prompt beside the `report_finding` field list so it cannot be reworded
 * out of existence by an edit to a SKILL.md. `capTestFindingSeverity` is the
 * deterministic half: the prompt asks, the code enforces, on the one class
 * where the answer is not a judgment (a finding whose cited path is a test file).
 */

/**
 * The severity rubric every lens is handed. One rubric for six lenses because
 * the ladders do not agree with each other.
 *
 * The floor is on evidence, not on categories: a category of code (`implicit
 * any`) is never itself high, and harm stated only as "impedes understanding" is
 * a maintainability opinion, not a failure.
 */
export const SEVERITY_RUBRIC = `## How to choose a severity

Severity is a claim about harm. The level you pick must be backed by harm you can state.

**CRITICAL or HIGH requires at least ONE of these, stated in the finding:**
  (a) a concrete, reachable failure on a realistic input — name the input and what goes wrong;
  (b) data loss or corruption;
  (c) a security exposure an attacker can actually reach — name the path to it;
  (d) a requirement stated in the issue that this diff violates.
If you cannot state one of those for THIS finding, it is not HIGH.

**Cap at MEDIUM or LOW — these are nits however you label them:**
  - style, naming and typing nits (missing annotations, \`Any\`, implicit any);
  - duplication and dead code;
  - findings about test-only code;
  - performance claims not measured on a demonstrated hot path;
  - harm stated only as "impedes understanding" or "makes maintenance harder".

This rubric OVERRIDES your lens skill wherever the two conflict, including any
severity ladder that assigns HIGH to a category of code or to maintainability
alone. Where your skill calls a class of finding HIGH and this rubric caps it,
report the severity the reachable impact of your finding actually warrants.`;

/** A test path segment: a directory component, matched case-insensitively. */
const TEST_PATH_SEGMENTS = new Set(["tests", "test", "smoke-tests"]);

/** A test basename: `test_*.*`, `*_test.*`, `*.test.*`, `*.spec.*`. */
const TEST_BASENAME = /^(test_[^/]+\.[^/]+|[^/]+_test\.[^/]+|[^/]+\.(test|spec)\.[^/]+)$/i;

/**
 * True when `path` names a test file: a `tests/`, `test/` or `smoke-tests/`
 * path segment, or a basename of one of the four test shapes.
 *
 * Pure, and deliberately narrower than the write-fence's `isTestPath`
 * (work-driver-plan-paths.ts), which answers "may a developer edit this" for
 * `test-*.ts` names too. This one answers "is the cited code a test", and the
 * spec's four shapes are its contract: the four prefixes are what a test file
 * looks like, and `test-` is not one of them. A file named `test-helpers.ts`
 * is fixture code that production imports, and capping a finding on it would
 * silence a reviewer about shipped code.
 */
export function isTestFilePath(path: string): boolean {
  if (path === "") return false;
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.some((s) => TEST_PATH_SEGMENTS.has(s.toLowerCase()))) return true;
  return TEST_BASENAME.test(segments[segments.length - 1] ?? "");
}

/**
 * The deterministic cap: a finding whose cited path is a test file cannot be
 * labelled above MEDIUM. CRITICAL passes through untouched — a test that
 * asserts the wrong thing can hide a genuine critical, and that call is the
 * reviewer's to make.
 *
 * This is not a second opinion on the lens's judgment, it is the one class where
 * there is no judgment to make: no finding about test-only code is a merge
 * blocker under the rubric, and the prompt alone did not hold (test-only deltas
 * were the loudest source of inflated HIGHs in the pass that motivated it).
 */
export function capTestFindingSeverity<T extends { severity: Severity; path: string }>(
  finding: T,
): T {
  if (finding.severity === "CRITICAL" || !isTestFilePath(finding.path)) return finding;
  if (finding.severity === "MEDIUM" || finding.severity === "LOW") return finding;
  return { ...finding, severity: "MEDIUM" };
}
