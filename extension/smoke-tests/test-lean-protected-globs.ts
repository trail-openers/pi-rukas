/**
 * The `lean.protectedPaths` glob matcher against git itself. Every expectation below was
 * read off `git check-ignore` in a scratch repo, not off a summary of the gitignore docs,
 * so this table is the executable statement of what the matcher in `protected-globs.ts`
 * means. Rows that look "obvious" and are wrong are called out where they sit.
 */
import { protectedGlobMatches } from "../src/lean/protected-globs.ts";
import {
  runSlowShapeCases,
  SLOW_CASE_COUNT,
} from "./lib/lean-protected-glob-shapes.ts";

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
  // A path the filesystem cannot hold is answered PROTECTED for any entry, with the regex never
  // running: NAME_MAX caps one segment at 255 bytes and PATH_MAX the whole path at 4096, so
  // neither shape is one git ever reported, and the one that somehow arrives is reverted rather
  // than trusted. The two limits are independent: the first row is one oversized segment inside
  // a short path, the second one oversized path made of legal segments, and the third is over
  // PATH_MAX while `**` would have matched it anyway — an entry that matches nothing is enough,
  // because protection here does not depend on the entry.
  ["**/*/**/*q*r?s*t", `${"q-".repeat(128)}x`, true],
  ["src/**", `${"x".repeat(300)}/${"y".repeat(300)}`, true],
  ["no-such-dir/**", "x".repeat(4097), true],
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
  // What a match and a non-match COST, and which spellings the loader must refuse outright, is the
  // other half of this contract and lives in lib/lean-protected-glob-shapes.ts.
  failures += runSlowShapeCases();
  if (failures > 0) {
    console.error(
      `${failures} of ${String(CASES.length + SLOW_CASE_COUNT)} protected-glob cases failed`,
    );
    process.exit(1);
  }
  console.log(
    `ok  ${String(CASES.length)} protected-glob cases match git-ignore semantics, and the worst accepted shapes stayed under the timing ceiling`,
  );
}

runCases();
