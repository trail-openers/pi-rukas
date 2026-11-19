/**
 * The `lean.protectedPaths` glob matcher against git itself. Every expectation below was
 * read off `git check-ignore` in a scratch repo, not off a summary of the gitignore docs,
 * so this table is the executable statement of what the matcher in `protected-globs.ts`
 * means. Rows that look "obvious" and are wrong are called out where they sit.
 */
import { protectedGlobMatches, protectedPathProblem } from "../src/lean/protected-globs.ts";

export const CASES: Array<[string, string, boolean]> = [
  // A single-segment pattern is a basename and matches at any depth.
  ["angular.json", "angular.json", true],
  ["angular.json", "src/angular.json", true],
  ["angular.json", "src/angular.jsonx", false],
  ["angular.json", "xangular.json", false],
  ["package*.json", "package.json", true],
  ["package*.json", "package-lock.json", true],
  ["package*.json", "pkg/package.json", true],
  // `*` never crosses a separator, so a slash inside the name breaks the match.
  ["package*.json", "package.a/b.json", false],
  // A leading doublestar absorbs depth on both sides of the literal segment, and the
  // trailing doublestar needs something UNDER that segment: a file called `theme` is not
  // covered by this spelling, and `a/theme` is not either.
  ["**/theme/**", "a/b/theme/x.css", true],
  ["**/theme/**", "theme/x.css", true],
  ["**/theme/**", "a/theme/b.css", true],
  ["**/theme/**", "x/theme/a/b", true],
  ["**/theme/**", "themeless/x", false],
  ["**/theme/**", "a/theme", false],
  ["**/theme/**", "theme", false],
  // An anchored `name/**` covers everything under that name AT THE ROOT and refuses the
  // node itself; it is anchored, so a theme folder nested elsewhere is untouched.
  ["theme/**", "theme", false],
  ["theme/**", "theme/a", true],
  ["theme/**", "theme/a/b/c", true],
  ["theme/**", "src/theme/x.css", false],
  ["theme/**", "a/theme/b.css", false],
  ["theme/**", "themex/a", false],
  // A trailing slash names a directory and everything under it. It does NOT anchor, so a
  // folder of that name anywhere in the tree is covered — but the node itself never is.
  ["theme/", "theme", false],
  ["theme/", "theme/a.css", true],
  ["theme/", "a/theme/b.css", true],
  ["src/theme/", "src/theme/a.css", true],
  ["src/theme/", "vendor/theme/a.css", false],
  // `**` between segments absorbs zero or more whole segments.
  ["src/**/*.ts", "src/a.ts", true],
  ["src/**/*.ts", "src/a/b.ts", true],
  ["src/**/*.ts", "src/a/b/c.ts", true],
  ["src/**/*.ts", "other/a.ts", false],
  ["docs/**", "docs", false],
  ["docs/**", "docs/a", true],
  ["docs/**", "docs/a/b.md", true],
  ["a/**", "a", false],
  ["a/**", "a/b", true],
  ["a/**", "a/b/c", true],
  ["a/**/b", "a/b", true],
  ["a/**/b", "a/x/b", true],
  ["a/**/b", "a/x/y/b", true],
  ["a/**/b", "a/xb", false],
  ["a/**/b", "xa/b", false],
  ["src/**", "src/a/b", true],
  ["src/theme/**", "src/theme/x.css", true],
  ["src/theme/**", "src/themex/x.css", false],
  ["**/x", "x", true],
  ["**/x", "a/b/x", true],
  ["**/x", "ax", false],
  ["**", "a/b/c", true],
  ["**", "a", true],
  ["src/", "src/a/b.ts", true],
  ["*", "a", true],
  // A bare `*` is a single-segment pattern, so the basename rule makes it match at any
  // depth — the one row here that most people get backwards.
  ["*", "a/b", true],
  ["a*/", "ab/x", true],
  [".env", "x/.env", true],
  ["a/b", "x/a/b", false],
  // `?` is exactly one character inside a segment.
  ["a?c.ts", "abc.ts", true],
  ["a?c.ts", "a/c.ts", false],
  // Regex metacharacters in a pattern are literal, not wildcards.
  ["a+b.ts", "a+b.ts", true],
  ["a.b.ts", "axbx.ts", false],
  ["a|b.ts", "a|b.ts", true],
  ["(x).ts", "(x).ts", true],
  // The matcher compiles the NORMALISED entry (a run of `*` inside one segment is one `*`; two
  // adjacent `**` segments are one), so these spellings must name exactly what the short ones
  // name. Each pair below has the same answer on every path it shares with the rows above.
  //   `a/**/**/b` vs `a/**/b` — the doubled doublestar absorbs nothing more than the single one.
  ["a/**/**/b", "a/b", true],
  ["a/**/**/b", "a/x/b", true],
  ["a/**/**/b", "a/x/y/b", true],
  ["a/**/**/b", "a/xb", false],
  ["a/**/**/b", "xa/b", false],
  ["a/**/**/**/b", "a/x/y/b", true],
  ["a/**/**/**/b", "xa/b", false],
  //   `a***b` vs `a*b` — the extra stars are further `[^/]*`s, which absorb what one absorbs.
  ["a***b", "ab", true],
  ["a***b", "axb", true],
  ["a***b", "ax/b", false],
  ["a****b", "ab", true],
  ["a****b", "axb", true],
  // The normalised spellings agree with the short ones at every depth, including the anchored
  // and the trailing-slash shapes where a stray segment would show up.
  ["src/**/**/**/*.ts", "src/a.ts", true],
  ["src/**/**/**/*.ts", "src/a/b/c.ts", true],
  ["src/**/**/**/*.ts", "other/a.ts", false],
  ["theme/**/**", "theme", false],
  ["theme/**/**", "theme/a/b", true],
  ["theme/**/**", "src/theme/x.css", false],
  ["**/**/theme/**", "a/theme/b.css", true],
  ["**/**/theme/**", "theme", false],
];

export function runCases(): void {
  let failures = 0;
  for (const [pattern, file, want] of CASES) {
    const got = protectedGlobMatches(pattern, file);
    if (got !== want) {
      failures++;
      console.error(
        `FAIL  ${JSON.stringify(pattern)} vs ${JSON.stringify(file)}  got ${got} want ${want}`,
      );
    }
  }
  for (const [name, pattern, file] of SLOW_ACCEPTED) {
    // A non-match costs most on a DEEP path for these shapes, so the same 200 characters are
    // tried as one wide segment and as a column of them. EVERY probe is timed and the MAXIMUM is
    // the verdict: a short-circuiting `some` stops at the first probe and can only ever
    // under-report the cost this row exists to bound.
    const probes = [file, DEEP_NO_MATCH_PATH, "x/".repeat(99) + "x", "x/".repeat(59) + "x"];
    let matched = false;
    let worst = 0;
    for (const probe of probes) {
      const started = performance.now();
      if (protectedGlobMatches(pattern, probe)) matched = true;
      const ms = performance.now() - started;
      if (ms > worst) worst = ms;
    }
    if (matched) {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} unexpectedly matched one of the ${String(probes.length)} probe paths`,
      );
    }
    if (worst > SLOW_CEILING_MS) {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} vs ${String(probes.length)} non-matching paths (widest ${String(file.length)} chars, deepest ${String(DEEP_NO_MATCH_PATH.split("/").length)} segments) took ${worst.toFixed(1)}ms, over the ${String(SLOW_CEILING_MS)}ms ceiling`,
      );
    } else {
      console.log(`ok  ${name} matched nothing in ${worst.toFixed(1)}ms`);
    }
  }
  for (const [name, pattern] of SLOW_REFUSED) {
    // The ceiling's other half, and the one an accepted-shape timer cannot see: a shape whose
    // cost grows with the DEPTH of a path that never matches is refused at LOAD. With no ceiling
    // low enough, the loader admits it, says nothing, and this row is red.
    const refusal = protectedPathProblem(pattern);
    if (refusal === undefined) {
      failures++;
      console.error(`FAIL  ${name}: ${JSON.stringify(pattern)} was admitted by the loader`);
    } else {
      console.log(`ok  ${name} refused at load (${refusal})`);
    }
  }
  if (failures > 0) {
    console.error(
      `${failures} of ${String(CASES.length + SLOW_ACCEPTED.length + SLOW_REFUSED.length)} protected-glob cases failed`,
    );
    process.exit(1);
  }
  console.log(
    `ok  ${String(CASES.length)} protected-glob cases match git-ignore semantics, and ${String(SLOW_ACCEPTED.length)} worst accepted shapes stayed under ${String(SLOW_CEILING_MS)}ms`,
  );
}

/** How long one accepted entry may take against a path it does NOT match. A regex over
 *  wildcards backtracks, so this is the one cost a project's own config file can choose. */
const SLOW_CEILING_MS = 50;

/** A path of 200 characters that none of {@link SLOW_ACCEPTED} names: one wide segment, so a
 *  `*` can never cross into the pattern's literals. */
const NO_MATCH_PATH = "x".repeat(200);

/** The same characters as a COLUMN of 400 one-character segments. A doublestar's cost is a
 *  function of the number of segment splits a path offers, not of its length, so this is where
 *  an admitted entry pays most, and the reason the ceiling is a count of `**` SEGMENTS rather
 *  than a bound on entry length: the refused shapes below are nineteen characters long. */
const DEEP_NO_MATCH_PATH = "x/".repeat(400) + "x";

/**
 * The worst shapes the loader ADMITS, each against a 200-character path and a 400-segment path
 * it does not match — the input that makes a backtracking matcher pay. The `protectedPathProblem`
 * ceilings are what keep these cheap: cost grows like (path depth)^(doublestar segments), so at
 * the admitted maximum these stay well under {@link SLOW_CEILING_MS} and one segment past it,
 * they do not (see {@link SLOW_REFUSED}).
 */
const SLOW_ACCEPTED: Array<[string, string, string]> = [
  // Two doublestar segments separated by a `?`, and the widest segment at the four-wildcard
  // ceiling — together the most of each the loader admits in one entry. Timed against the DEEP
  // path: its third probe is the wide 200-character one, so both axes are paid for every row.
  ["2 doublestars separated by literals", "?/**/?/**/?x", DEEP_NO_MATCH_PATH],
  // A doublestar at each end of a wildcard-heavy segment: the two splits multiply into each
  // other rather than into a second literal, so this is the other shape worth timing.
  ["2 doublestars around a wide tail", "**/*q*r?s*t/**/?x", DEEP_NO_MATCH_PATH],
  // Both doublestars behind one literal, where a run of them multiplies fastest at its top end.
  ["2 doublestars behind one literal", "a/**/**/b", DEEP_NO_MATCH_PATH],
  // A segment at the wildcard ceiling, beside the run of doublestars it has to be placed into.
  ["2 doublestars and a 4-wildcard segment", "a/**/**/*q*r?s*t", DEEP_NO_MATCH_PATH],
];

/**
 * Shapes the loader must REFUSE rather than admit, because their cost on a non-matching path
 * grows with that path's depth. Each row is one `**` segment over the ceiling with the cheapest
 * spelling that still backtracks: single-character segments between the doublestars and a tail
 * the path can never satisfy. This is the entry the ceiling exists for — one that normalisation
 * cannot collapse, and that a length bound cannot catch at 19 characters.
 */
const SLOW_REFUSED: Array<[string, string]> = [
  ["3 doublestars with one-character segments", "?/**/?/**/?/**/?x"],
  ["4 doublestars with one-character segments", "?/**/?/**/?/**/?/**/?x"],
  // The same three-doublestar shape behind a wildcard-heavy tail — over 300 ms on the deep path
  // with a length bound that reads 21 characters, so the refusal is the only defence.
  ["3 doublestars ahead of an anchored tail", "**/*/**/*/**/*q*r?s*t"],
];

runCases();
