/**
 * lean/config-test-location — where the adversary's acceptance tests live.
 *
 * Split from `config.ts` for the file-size cap; the same `.pi/work.json` `verify` block, read and validated
 * at the same boundary. The three questions here are the three a project answers when it wants its OWN CI
 * to run the tests a lean run freezes:
 *
 *   - `validateTestDir` — is this a repo-relative directory, or something that only looks like one?
 *   - `validateTestGlob` — is this a single-`*` BASENAME pattern?
 *   - `testLocationProblem` — does a submitted test path sit directly inside that directory under that
 *     name? What the boundary in `specify-tree.ts` calls.
 *
 * The pair is configured together or not at all: `loadWorkConfig` refuses a half-set.
 */

/** The pair of settings that say where the adversary's tests live. */
export interface TestLocation {
  testDir: string;
  testGlob: string;
}

/**
 * Characters neither setting may contain. Shell metacharacters and quotes have no business in a name the
 * prompt quotes back to a child.
 *
 * The second class is INVISIBLE: zero-width and bidi characters, BOM, line/paragraph separators, C0/C1
 * controls. `"tests\u200b"` looks exactly like `"tests"` but the boundary compares verbatim, matching
 * nothing and refusing every test the adversary writes. `\p{Cc}` covers C0/C1 only, so the rest are spelled
 * out.
 *
 * `*` and `?` are refused in a DIRECTORY only: a lone `*` IS the `testGlob` pattern.
 */
const TEST_LOCATION_FORBIDDEN =
  /[;&|`$<>"'\\\n\r]|\p{Cc}|\u0085|\u2028|\u2029|[\u200b-\u200f\u2060-\u2064\ufeff]/u;

/** A directory additionally has no wildcard at all — that is what `testGlob` is for. */
const TEST_DIR_FORBIDDEN = /[?*]/;

/**
 * Why this `verify.testDir` is not usable, or undefined when it is.
 *
 * The shape rule for a repo-relative directory: the refusals `pathProblem` applies to a submitted test path
 * plus the two a directory adds — no trailing slash, nothing inside a hidden directory.
 *
 * And ONE canonical form: the value must equal its own normalised form, since the boundary compares it
 * against a submitted path's NORMALISED directory — `./tests` or `tests//unit` matches nothing. The refusal
 * prints the form to write rather than quietly normalising: a config whose value the code rewrites is one
 * nobody can read off the file.
 */
export function validateTestDir(dir: string): string | undefined {
  if (dir.trim() === "") return ".pi/work.json verify.testDir must not be empty";
  if (dir !== dir.trim())
    return `.pi/work.json verify.testDir must not have surrounding whitespace — the value is used verbatim, so \`${dir}\` would name a directory that does not exist`;
  if (TEST_LOCATION_FORBIDDEN.test(dir))
    return `.pi/work.json verify.testDir must be a plain repo-relative directory: ; & | \` $ < > " ' \\ and newline are not allowed, and neither is an invisible/control character (${dir})`;
  if (TEST_DIR_FORBIDDEN.test(dir))
    return `.pi/work.json verify.testDir must be a plain repo-relative directory with no wildcard: * and ? are what verify.testGlob is for (${dir})`;
  if (dir.startsWith("/") || dir.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(dir))
    return `.pi/work.json verify.testDir must be repo-relative, not absolute (${dir})`;
  if (dir.endsWith("/") || dir.endsWith("\\"))
    return `.pi/work.json verify.testDir must not end in a slash (${dir})`;
  const segments = dir.split(/[\\/]+/).filter((s) => s !== "");
  if (segments.length === 0) return `.pi/work.json verify.testDir must name a directory (${dir})`;
  if (segments.includes("..")) return `.pi/work.json verify.testDir must not contain ".." (${dir})`;
  // Against the NORMALISED form, so a `.` segment reads as the spelling mistake it is.
  const normalised = segments.filter((s) => s !== ".").join("/");
  // `.` alone normalises to nothing — the repo root, not a directory the author named.
  if (normalised !== "" && dir !== normalised)
    return `.pi/work.json verify.testDir has exactly one spelling — write \`${normalised}\` (the value is compared verbatim against a submitted test's directory, so \`${dir}\` would match nothing)`;
  if (segments.some((s) => s.startsWith(".")))
    return `.pi/work.json verify.testDir must not sit inside a hidden directory (${dir})`;
  return undefined;
}

/**
 * Why this `verify.testGlob` is not usable, or undefined when it is.
 *
 * A BASENAME pattern with exactly one `*`: the boundary matches it against the final path segment, so a
 * slash would silently match nothing.
 */
export function validateTestGlob(glob: string): string | undefined {
  if (glob.trim() === "") return ".pi/work.json verify.testGlob must not be empty";
  if (glob !== glob.trim())
    return `.pi/work.json verify.testGlob must not have surrounding whitespace — the value is matched verbatim against a file name, so \`${glob}\` would match nothing`;
  if (glob.includes("/") || glob.includes("\\"))
    return `.pi/work.json verify.testGlob is a file-name pattern, not a path: no slashes (${glob})`;
  const stars = glob.split("*").length - 1;
  if (stars !== 1)
    return `.pi/work.json verify.testGlob must contain exactly one "*", found ${stars} (${glob})`;
  if (glob.includes("?"))
    return `.pi/work.json verify.testGlob supports exactly one "*"; "?" is not part of the pattern (${glob})`;
  if (TEST_LOCATION_FORBIDDEN.test(glob))
    return `.pi/work.json verify.testGlob must be a plain file-name pattern: ; & | \` $ < > " ' \\ and newline are not allowed, and neither is an invisible/control character (${glob})`;
  // The four below all say the same thing: the pattern names no RUNNABLE TEST FILE, so frozen tests
  // quietly escape it.
  if (glob === "*")
    return `.pi/work.json verify.testGlob must not be "*": that matches every file in the directory, so the run could freeze anything as an acceptance test (${glob})`;
  if (glob.startsWith("."))
    return `.pi/work.json verify.testGlob must not start with ".": a leading dot is a hidden file, which is not a test file the project's CI runs (${glob})`;
  // A pattern whose `*` is the last character names no file type at all. Placed after the `*`-count rule.
  if (!glob.slice(glob.indexOf("*") + 1).includes("."))
    return `.pi/work.json verify.testGlob must name a file extension after the "*" — a pattern like \`test-*\` matches files with no extension, which no test runner executes (${glob})`;
  return undefined;
}

/**
 * Whether `glob` names Python files — the one question the runner probe asks of a `testGlob`, and the only
 * place the extension is read off a pattern.
 *
 * The extension is the text after the `*`, and it has to be the SUFFIX of that tail, not a dot-something in
 * the middle — `test_*.pytest.js` names `.js` files, and a probe chosen for it is the wrong file in the
 * wrong language.
 *
 * Why language matters at all: pytest is the only runner in the common set whose import step refuses a file
 * it cannot import, so the probe's NAME (not its content) decides whether the runner reaches the point
 * where it can report. See `specify-preflight.ts`.
 *
 * The comparison folds CASE because the question is which LANGUAGE the tests are written in. `.pyi` is a
 * stub declaration, not an executable test module.
 */
export function globNamesPythonFiles(glob: string): boolean {
  const star = glob.indexOf("*");
  if (star < 0) return false;
  // Folded once, here, so the comparison below has one spelling to mean.
  const tail = glob.slice(star + 1).toLowerCase();
  if (!(tail.length >= ".py".length && tail.endsWith(".py"))) return false;
  // The extension is the tail after the LAST dot — those are the files the runner collects.
  const lastDot = tail.lastIndexOf(".");
  return lastDot >= 0 && tail.slice(lastDot) === ".py";
}

/**
 * The configured test location, or undefined when the project has not chosen one. A half-set pair cannot
 * reach this through the loader, and a hand-built config gets no location rather than a guess about which
 * half was meant.
 */
export function testLocationOf(verify: {
  testDir?: string;
  testGlob?: string;
}): TestLocation | undefined {
  const { testDir, testGlob } = verify;
  if (testDir === undefined || testGlob === undefined) return undefined;
  return { testDir, testGlob };
}

/**
 * `pattern` with its single `*` turned into an anchored, escaped regex: `test-*.ts` becomes
 * `^test-[^/]*\.ts$`. Module-private — callers ask via `globMatches`.
 */
function globToRegex(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`))
    .join("[^/]*");
  return new RegExp(`^${source}$`);
}

/**
 * Does `verify.testGlob` match the basename `name`? The one matcher, because `specify-preflight.ts` has to
 * ask the same question the boundary asks.
 */
export function globMatches(pattern: string, name: string): boolean {
  return globToRegex(pattern).test(name);
}

/**
 * Why this worktree-relative test path is not inside the configured test location, or undefined when it
 * is. Two questions on the NORMALISED path: is the file DIRECTLY inside `testDir` (a nested subdirectory
 * is outside it — the project's CI glob would not reach it), and does its basename match `testGlob`.
 */
export function testLocationProblem(loc: TestLocation, rel: string): string | undefined {
  const segments = rel.split("/");
  const base = segments[segments.length - 1] ?? "";
  const dir = segments.slice(0, -1).join("/");
  if (dir !== loc.testDir)
    return `test ${rel} is not directly inside the configured test directory ${loc.testDir}/ (.pi/work.json verify.testDir)`;
  if (!globMatches(loc.testGlob, base))
    return `test ${rel} does not match the configured test name pattern ${loc.testGlob} (.pi/work.json verify.testGlob)`;
  return undefined;
}
