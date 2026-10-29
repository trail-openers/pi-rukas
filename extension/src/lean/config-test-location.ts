/**
 * lean/config-test-location — where the adversary's acceptance tests live.
 *
 * Split from `config.ts` for the file-size cap; it is the same `.pi/work.json`
 * `verify` block, read the same way, validated at the same boundary. The three
 * questions here are the three a project answers when it wants its OWN CI to
 * run the tests a lean run freezes:
 *
 *   - `validateTestDir`  — is this a repo-relative directory, or something that
 *     only looks like one (absolute, traversing, hidden, trailing-slash, a
 *     pattern wearing a directory's name)?
 *   - `validateTestGlob` — is this a single-`*` BASENAME pattern?
 *   - `testLocationProblem` — does a submitted test path sit directly inside
 *     that directory under that name? This is what the boundary in
 *     `specify-tree.ts` calls, after `pathProblem` has already ruled out
 *     traversal.
 *
 * The pair is configured together or not at all: `loadWorkConfig` refuses a
 * half-set pair, so the steps never have to guess which half the author meant.
 */

/** The pair of settings that say where the adversary's tests live. */
export interface TestLocation {
  testDir: string;
  testGlob: string;
}

/**
 * Characters neither setting may contain. Shell metacharacters and quotes have
 * no business in a name the prompt quotes back to a child.
 *
 * The second class is INVISIBLE: zero-width and bidi characters, BOM, the
 * line/paragraph separators and every other C0/C1 control. A value like
 * `"tests\u200b"` looks exactly like `"tests"` in the config file and in the
 * prompt, but the boundary compares the string verbatim, so it matches nothing
 * and every test the adversary writes is refused while the reason blames the
 * child — the same failure the whitespace rule above refuses, one the eye
 * cannot see. `\p{Cc}` covers C0 (incl. NUL) and C1 but not U+0085, U+2028/9,
 * the U+200B–U+2064 formatting group or U+FEFF, which are spelled out.
 *
 * `*` and `?` are refused in a DIRECTORY only, and checked there separately: a
 * lone `*` IS the `testGlob` pattern, so a shared set that refused it would
 * reject every legal glob (a validator that cannot express the one shape it
 * exists to accept is the bug this split prevents).
 */
const TEST_LOCATION_FORBIDDEN =
  /[;&|`$<>"'\\\n\r]|\p{Cc}|\u0085|\u2028|\u2029|[\u200b-\u200f\u2060-\u2064\ufeff]/u;

/** A directory additionally has no wildcard at all — that is what `testGlob` is for. */
const TEST_DIR_FORBIDDEN = /[?*]/;

/**
 * Why this `verify.testDir` is not usable, or undefined when it is.
 *
 * The shape rule for a repo-relative directory: the same refusals `pathProblem`
 * applies to a submitted test path (`..` traversal, absolute paths, drive
 * letters, empty segments) plus the two a directory adds — no trailing slash,
 * and nothing inside a hidden directory, which is where `pathProblem`'s
 * forbidden-segment list would otherwise have caught it.
 *
 * And ONE canonical form: the value must equal its own normalised form (no `.`
 * segments, no doubled separators). The boundary compares this string against a
 * submitted path's NORMALISED directory, so a value that merely *spells* the
 * same folder differently — `./tests`, `tests//unit` — matches nothing, and the
 * child is told its own tests are misplaced. The refusal prints the form to
 * write rather than quietly normalising, because a config whose value the code
 * silently rewrites is a config nobody can read off the file.
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
  // Compared against the NORMALISED form, so a `.` segment (`./tests`) is
  // reported as the spelling mistake it is and not swallowed by the hidden-
  // directory rule below — whose message ("do not put your tests in a hidden
  // folder") is the wrong instruction for a value that only *starts* with a dot
  // because of punctuation.
  const normalised = segments.filter((s) => s !== ".").join("/");
  // `.` alone (or `./.`) normalises to nothing, which is the repo root — not a
  // directory the author named. The hidden-directory rule below still owns it,
  // so the message says "a directory", not "write the empty string".
  if (normalised !== "" && dir !== normalised)
    return `.pi/work.json verify.testDir has exactly one spelling — write \`${normalised}\` (the value is compared verbatim against a submitted test's directory, so \`${dir}\` would match nothing)`;
  if (segments.some((s) => s.startsWith(".")))
    return `.pi/work.json verify.testDir must not sit inside a hidden directory (${dir})`;
  return undefined;
}

/**
 * Why this `verify.testGlob` is not usable, or undefined when it is.
 *
 * A BASENAME pattern with exactly one `*`: the boundary matches it against the
 * final path segment, so a slash would mean the author spelled the directory
 * twice (once in `testDir`, once here) and would silently match nothing.
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
  // The four below all say the same thing in git's own words: the pattern names
  // no RUNNABLE TEST FILE. A project whose CI glob cannot name one has a config
  // that every frozen test quietly escapes, so each is refused at the loader.
  if (glob === "*")
    return `.pi/work.json verify.testGlob must not be "*": that matches every file in the directory, so the run could freeze anything as an acceptance test (${glob})`;
  if (glob.startsWith("."))
    return `.pi/work.json verify.testGlob must not start with ".": a leading dot is a hidden file, which is not a test file the project's CI runs (${glob})`;
  // `*` opens the wildcard and the extension is what follows it — so a pattern
  // whose `*` is the last character names no file type at all (`test-` matches
  // no runnable file). Checked after the `*`-count rule, which already rejects
  // the zero-star and multi-star shapes this would otherwise be read against.
  if (!glob.slice(glob.indexOf("*") + 1).includes("."))
    return `.pi/work.json verify.testGlob must name a file extension after the "*" — a pattern like \`test-*\` matches files with no extension, which no test runner executes (${glob})`;
  return undefined;
}

/**
 * The configured test location, or undefined when the project has not chosen
 * one. Absent-by-default is today's behaviour.
 *
 * `loadWorkConfig` validates before it builds, so a half-configured pair cannot
 * reach this through the loader; a hand-built config (a test, or a future
 * caller) still gets no location rather than a guess about which half was meant.
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
 * `pattern` with its single `*` turned into a regex, anchored and escaped.
 * `test-*.ts` becomes `^test-[^/]*\.ts$` — a basename pattern, which is what
 * the boundary matches a submitted file's last segment against.
 */
function globToRegex(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`))
    .join("[^/]*");
  return new RegExp(`^${source}$`);
}

/**
 * Why this worktree-relative test path is not inside the configured test
 * location, or undefined when it is.
 *
 * Two questions, both answered on the NORMALISED path the boundary already
 * computed: is the file DIRECTLY inside `testDir` (a nested subdirectory is
 * outside it — the project's CI glob would not reach it), and does its basename
 * match `testGlob`. Called after `pathProblem`, so the path is already known
 * traversal-free and slash-clean.
 */
export function testLocationProblem(loc: TestLocation, rel: string): string | undefined {
  const segments = rel.split("/");
  const base = segments[segments.length - 1] ?? "";
  const dir = segments.slice(0, -1).join("/");
  if (dir !== loc.testDir)
    return `test ${rel} is not directly inside the configured test directory ${loc.testDir}/ (.pi/work.json verify.testDir)`;
  if (!globToRegex(loc.testGlob).test(base))
    return `test ${rel} does not match the configured test name pattern ${loc.testGlob} (.pi/work.json verify.testGlob)`;
  return undefined;
}
