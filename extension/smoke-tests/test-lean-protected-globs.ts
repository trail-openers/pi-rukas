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
  if (failures > 0) {
    console.error(`${failures} of ${CASES.length} protected-glob cases failed`);
    process.exit(1);
  }
  console.log(`ok  ${CASES.length} protected-glob cases match git-ignore semantics`);
}

runCases();
