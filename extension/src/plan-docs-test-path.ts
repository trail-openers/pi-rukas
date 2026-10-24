/**
 * plan-docs-test-path — #1250 change 1: is a fence entry a DOCUMENTATION or a
 * TEST path?
 *
 * The field failure this answers: for an N=1 cycle the planner writes the
 * project's docs pages and its test files into the single workstream's
 * `outOfScope` on its own initiative — the plan prompt demands a non-empty
 * fence, and docs and tests are what a planner fences when the issue named
 * nothing to fence. A developer who then follows the project's own rules
 * ("every change updates its tests and its documentation page") touches one of
 * them, and `work-driver-scope-fanout.ts` parks `verify-failed:develop` with
 * `touched out-of-scope path <file> — declared fence violated (issue-fenced)`
 * after 90–170 minutes of develop. The developer was right and the fence was
 * the planner's invention.
 *
 * So the plan-time unfence (work-driver-plan-unfence.ts) opens docs/test
 * fences for an N=1 plan, and this module is the ONE predicate that decides
 * what counts. Two shapes, both answered from the entry text alone with no
 * I/O:
 *
 *   - **Documentation** — a prose extension (`.md`, `.mdx`, `.rst`, `.adoc`,
 *     `.txt`) or a directory segment named `docs` / `doc` / `manual` / `man`.
 *     A directory entry such as `host/docs/` counts: a fenced tree of docs is
 *     the same fence as its pages.
 *   - **Test** — a directory segment named `test` / `tests` / `__tests__` /
 *     `spec` / `smoke-tests`, or a test-shaped basename (`*_test.*`,
 *     `*.test.*`, `*.spec.*`, `test_*.*`, `test-*.*`).
 *
 * Why it is NOT `isTestPath` in work-driver-plan-paths.ts: that one is the
 * coupling rule's notion of a test (basename-shaped, TS-centric, no extension
 * wildcard) and has other callers whose behaviour #1250 must not change. This
 * predicate is deliberately wider in two ways that rule could not be — the
 * extension is any (`src/a_test.go`) and the directory counts — because it is
 * deciding "should this fence have been written at all", not "does this test
 * name this module".
 *
 * Deliberately NOT here: any judgement about whether the fence MAY be opened.
 * A broader fence that merely CONTAINS docs (`host/`) is a boundary the
 * planner drew around a tree for some other reason and the pass keeps it
 * unchanged; only an entry whose OWN shape is docs or test is opened. That
 * containment decision belongs to the pass, which also weighs the issue's
 * explicit prohibition — this module only answers the shape question.
 */

/** Prose/documentation extensions — the formats a project writes docs in. */
const DOC_EXT = /^(?:md|mdx|rst|adoc|txt)$/i;

/** Directory segments that mean "this is a documentation tree". */
const DOC_DIR = /^(?:docs?|manual|man)$/i;

/** Directory segments that mean "this is a test tree". */
const TEST_DIR = /^(?:tests?|__tests__|spec|specification|smoke-tests)$/i;

/**
 * The path's directory segments, lower-cased-ready, with the filename dropped.
 * A trailing separator (`host/docs/`) leaves no empty segment, so a directory
 * entry's last real segment is the directory it names — which is what makes
 * `host/docs/` a doc path while `host/` is not.
 */
function segments(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The basename of a path, or the whole string when it carries no separator. */
function basename(path: string): string {
  const segs = segments(path);
  return segs.length > 0 ? (segs[segs.length - 1] as string) : "";
}

/** The extension of a basename, without the dot; empty when it has none. */
function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1);
}

/** True when the path is documentation: a prose extension or a docs directory. */
export function isDocsPathEntry(path: string): boolean {
  const segs = segments(path);
  if (segs.length === 0) return false;
  const last = segs[segs.length - 1] as string;
  // A directory entry (`host/docs/`) has no extension on its final segment, so
  // the directory rule below is what catches it; a file's own name is never a
  // directory segment, so `docs.ts` is judged only by its extension.
  if (extension(last) && DOC_EXT.test(extension(last))) return true;
  // Every segment EXCEPT the last is a directory; for a directory entry the
  // last segment is a directory too, which is why the trailing separator is
  // what decides it.
  const dirSegs = path.endsWith("/") ? segs : segs.slice(0, -1);
  return dirSegs.some((s) => DOC_DIR.test(s));
}

/** True when the path is a test: a test directory or a test-shaped basename. */
export function isTestPathEntry(path: string): boolean {
  const segs = segments(path);
  if (segs.length === 0) return false;
  const last = segs[segs.length - 1] as string;
  const name = path.endsWith("/") ? "" : last;
  if (name) {
    const ext = extension(name);
    const stem = ext ? name.slice(0, name.length - ext.length - 1) : name;
    // *_test.* — `src/a_test.go`, `a_test.ts` (any extension, unlike isTestPath).
    if (ext && /_test$/i.test(stem)) return true;
    // *.test.* / *.spec.* — `a.test.ts`, `a.spec.ts`.
    if (ext && /\.(?:test|spec)$/i.test(stem)) return true;
    // test_*.* / test-*.* — `test_x.py`, `test-x.sh` (`latest.ts` fails: the
    // separator is what makes the prefix a name part, not a substring).
    if (/^test[-_]/i.test(name)) return true;
  }
  const dirSegs = path.endsWith("/") ? segs : segs.slice(0, -1);
  return dirSegs.some((s) => TEST_DIR.test(s));
}

/**
 * The rule's answer in one call: does this fence entry's own shape say
 * "documentation" or "test"?
 *
 * Returns the reason fragment the plan note carries (`docs-or-test path, N=1`
 * is assembled by the caller), or `undefined` when the entry is neither. The
 * two kinds are reported apart because an operator reading a handoff wants to
 * know which fence the driver opened.
 */
export function docsOrTestReason(path: string): "docs" | "test" | undefined {
  if (isDocsPathEntry(path)) return "docs";
  if (isTestPathEntry(path)) return "test";
  return undefined;
}
