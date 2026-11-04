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
 * or a basename of `test_*`, `*_test`, `*.test`, `*.spec` with a test-capable
 * extension, plus this repo's own `test-*.ts` convention (the smoke-tests tree is
 * named that way, so a lens reviewing a driver PR cites those files constantly).
 *
 * What it deliberately is NOT: `latest.ts` (no separator before `test`), a
 * `contest/` directory, and a basename whose extension is not one tests are
 * written in — `src/test-data.json` is a fixture, not test code. A bare `test`,
 * `test_x` with no extension, or a leading-dot name like `test_.py` is not one
 * either. (The directory rule is the one that still matches on segments alone:
 * `__tests__/helper.ts` is test code whatever its basename says.)
 */

/** Directory segments that mean "everything under here is test code". */
const TEST_DIR = /^(?:tests?|__tests__|smoke-tests)$/i;

/**
 * Test basenames, each with a required REAL extension drawn from the set this
 * repo's tests are actually written in — a dot followed by at least one
 * character that is neither a dot nor a slash, so `test_.py` and a bare `test_x`
 * are not test files. The extension is bounded on purpose: an open `[^./]+`
 * would cap `test-data.json` in `src/` (a fixture) or `notes.md` for no reason a
 * severity decision should rest on. This repo's own `test-*.ts` smoke-test
 * convention is included. Matching the basename only — never the whole path — is
 * what keeps a directory named `contest/` out.
 */
const TEST_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|rs)";
const TEST_BASENAME = new RegExp(
  `^(?:test[-_][^./]+\\.${TEST_EXT}|[^./]+_test\\.${TEST_EXT}|[^./]+\\.(?:test|spec)\\.${TEST_EXT})$`,
  "i",
);

/**
 * True when `path` cites test code. Apply it to `Finding.path` exactly as
 * `normalisePath` (lens-findings-extract.ts) leaves it — leading `./` stripped,
 * trailing `/` stripped — so the cap and the findings-store row key on the same
 * string.
 *
 * A basename carrying a non-test extension (`test-data.json`) is NOT test code —
 * unless a test DIRECTORY segment says otherwise, which overrides the basename
 * (everything under `tests/` is test code whatever it is named).
 */
export function isLensTestPath(path: string): boolean {
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.length === 0) return false;
  if (segments.some((s) => TEST_DIR.test(s))) return true;
  return TEST_BASENAME.test(segments[segments.length - 1] ?? "");
}
