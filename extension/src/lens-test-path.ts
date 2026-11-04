/**
 * lens-test-path — is the code a finding cites a test file?
 *
 * The one predicate the severity cap asks before it caps. It is lens-specific
 * on purpose: neither existing test-path predicate is this question.
 * `work-driver-plan-paths.ts`'s `isTestPath` is the write-fence/coupling notion
 * (TS-centric basenames, no directory segments, and its jsdoc scopes it to that
 * role), and `plan-docs-test-path.ts` is the plan-time "should this fence have
 * been written" question and its jsdoc explicitly declines a wider role. A cap
 * that borrowed either would change the behaviour of a fence or a planner as a
 * side effect of calibrating a severity.
 *
 * The shape: a directory segment of `tests`/`test`/`smoke-tests`/`__tests__`,
 * or a basename of `test_*.*`, `*_test.*`, `*.test.*`, `*.spec.*`, plus this
 * repo's own `test-*.ts` convention (the smoke-tests tree is named that way, so
 * a lens reviewing a driver PR cites those files constantly).
 *
 * What it deliberately is NOT: `latest.ts` (no separator before `test`) and a
 * `contest/` directory are not test paths. A basename must carry a real
 * extension — a dot followed by at least one character that is not a dot or a
 * slash — so a bare `test`, `test_x` with no extension, or a leading-dot name
 * like `test_.py` is not one either. (The directory rule is the one that still
 * matches on segments alone: `__tests__/helper.ts` is test code whatever its
 * basename says.)
 */

/** Directory segments that mean "everything under here is test code". */
const TEST_DIR = /^(?:tests?|__tests__|smoke-tests)$/i;

/**
 * Test basenames, each with a required REAL extension — a dot followed by at
 * least one character that is neither a dot nor a slash, so `test_.py` and a
 * bare `test_x` are not test files. This repo's own `test-*.ts` smoke-test
 * convention is included. Matching the basename only — never the whole path —
 * is what keeps a directory named `contest/` out.
 */
const TEST_BASENAME =
  /^(?:test[-_][^./]+\.[^./]+|[^./]+_test\.[^./]+|[^./]+\.(?:test|spec)\.[^./]+)$/i;

/**
 * True when `path` cites test code. Apply it to `Finding.path` exactly as
 * `normalisePath` (lens-findings-extract.ts) leaves it — leading `./` stripped,
 * trailing `/` stripped — so the cap and the findings-store row key on the same
 * string.
 */
export function isLensTestPath(path: string): boolean {
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.length === 0) return false;
  if (segments.some((s) => TEST_DIR.test(s))) return true;
  return TEST_BASENAME.test(segments[segments.length - 1] ?? "");
}
