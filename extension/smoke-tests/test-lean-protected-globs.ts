/**
 * The `lean.protectedPaths` glob matcher against git itself. Every expectation below was
 * read off `git check-ignore` in a scratch repo, not off a summary of the gitignore docs,
 * so this table is the executable statement of what the matcher in `protected-globs.ts`
 * means. Rows that look "obvious" and are wrong are called out where they sit.
 */
import { protectedGlobMatches } from "../src/lean/protected-globs.ts";

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
    // tried as one wide segment and as a column of them — the wider of the two is the verdict.
    const probes = [file, "x/".repeat(99) + "x", "x/".repeat(59) + "x"];
    const started = performance.now();
    const matched = probes.some((probe) => protectedGlobMatches(pattern, probe));
    const ms = performance.now() - started;
    if (matched) {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} unexpectedly matched one of the ${String(probes.length)} probe paths`,
      );
    }
    if (ms > SLOW_CEILING_MS) {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} vs ${String(probes.length)} non-matching paths of ${String(file.length)} chars took ${ms.toFixed(1)}ms, over the ${String(SLOW_CEILING_MS)}ms ceiling`,
      );
    } else {
      console.log(`ok  ${name} matched nothing in ${ms.toFixed(1)}ms`);
    }
  }
  if (failures > 0) {
    console.error(
      `${failures} of ${String(CASES.length + SLOW_ACCEPTED.length)} protected-glob cases failed`,
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
 *  `*` can never cross into the pattern's literals. {@link runCases} also tries it as a column
 *  of segments, which is where a backtracking engine pays most. */
const NO_MATCH_PATH = "x".repeat(200);

/**
 * The worst shapes the loader admits, each against a 200-character path it does not match —
 * the input that makes a backtracking matcher pay. The `protectedPathProblem` bounds are what
 * keep these cheap: every row below was measured at over half a second on the entry that has
 * no bound, and the last one is the shape the ceiling exists for — a run of doublestars ahead
 * of an anchored tail, where the cost grows with the DEPTH of a path that never matches.
 */
const SLOW_ACCEPTED: Array<[string, string, string]> = [
  // Four doublestar segments, each separated by a literal, and the widest segment at four
  // wildcards — the most of each the loader admits in one entry.
  [
    "4 doublestars separated by literals",
    "a/**/b/**/c/**/d/**/*e*f?g*h",
    NO_MATCH_PATH,
  ],
  // The same four, all of them behind one literal: a trailing run is where the doublestars
  // multiply fastest, and the loader collapses repeats but still admits four.
  ["4 doublestars behind one literal", "a/**/**/**/**/b", NO_MATCH_PATH],
  // A segment at the wildcard ceiling, beside a run of doublestars it has to be placed into.
  [
    "4 wildcards in one segment",
    "a/**/**/**/**/*q*r?s*t",
    NO_MATCH_PATH,
  ],
  // The discriminating shape: four doublestars AHEAD of an anchored tail. Every literal the
  // tail can never satisfy makes the engine try another split of the path, so the non-match
  // costs seconds rather than microseconds.
  [
    "4 doublestars ahead of an anchored tail",
    "**/**/**/**/**/*q*r?s*t",
    NO_MATCH_PATH,
  ],
];

runCases();
