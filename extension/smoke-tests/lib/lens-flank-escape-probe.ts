/**
 * lens-flank-escape-probe — the two alternatives of `mentionsPath` that every
 * other coverage fixture leaves unpinned.
 *
 * `mentionsPath` in `lens-review-coverage.ts` is
 * `(?:^|\n|NOT_PATH)ESCAPED(?:(?!PATH_CHAR)NOT_LINE_BREAK|TERMINATOR?(?:\r?\n|$))`.
 * Two of its parts were mutation-invisible before these cases:
 *
 *   - the LEFT flank's `\n` alternative. Every bullet fixture ("Notes:\n-
 *     src/c.ts") is rescued by `-` being a `NOT_PATH` member, and `\nNotes:`
 *     puts a LETTER next to the path, so deleting `\n|` from the alternation
 *     left both coverage files green. A BARE newline is the one left neighbour
 *     that is neither a non-path character nor the start of input, so
 *     `NL_OPEN` is the only fixture that witnesses the arm.
 *   - the escape class `[.*+?^${}()|[\]\\]`. Every denominator path in the
 *     other fixtures is regex-inert, so narrowing the class to `/\./g` passed
 *     the whole suite. `src/(legacy).ts` is not inert: unescaped, `(legacy)`
 *     collapses to an EMPTY CAPTURE GROUP and the two dots become single-char
 *     wildcards, so `META_UNESCAPED_FIT` — the text `srccclegacycts`, with
 *     `ccc`/`cts` standing in for the two wildcard runs — matches a file that
 *     was never named. That negative case is what makes `META_CITED` a real
 *     one: a dot-only escape keeps the positive assertion green for the wrong
 *     reason (a correctly escaped path does match its own literal), and only
 *     the negative one goes red.
 *
 * MUTATION-PROOF (each verified red, then byte-identical on restore, in
 * `lens-review-coverage.ts`):
 *   - delete `\n|` from the left flank   → NL_OPEN reddens alone (1 red).
 *   - narrow the escape class to `/\./g` → META_UNESCAPED_FIT reddens (1 red;
 *     META_CITED stays green, which is the point of pairing them).
 *
 * Each case is `[summary, denominatorFile, expectedClaim, why]`; the test
 * asserts `accountedFiles([row({ summary })], new Set([file]))?.get(file)`.
 * The denominators here are single-file sets on purpose: these cases pin how a
 * path is MATCHED, not what the round's denominator is, and a one-file set
 * keeps a red assertion unambiguous about which flank moved.
 */

/** A citation whose ONLY left boundary is the start of a line: the character
 * before `src/c.ts` is `\n` and nothing else — no bullet, no colon, no space.
 * Expected: accounted (`summary`). Red if the `\n` alternative is deleted. */
export const NL_OPEN: [string, string, "summary" | undefined, string] = [
  "Reviewed the delta.\nsrc/c.ts is fine",
  "src/c.ts",
  "summary",
  "a path at the start of a line opens a citation on the \\n flank alone — no bullet, no non-path character in front",
];

/** The same path, spelled with regex metacharacters, cited as itself.
 * Expected: accounted. Red if the escape class narrows to a dot only — and
 * green for the WRONG reason unless `META_UNESCAPED_FIT` is asserted with it. */
export const META_CITED: [string, string, "summary" | undefined, string] = [
  "Reviewed src/(legacy).ts and fixed it",
  "src/(legacy).ts",
  "summary",
  "a denominator path containing regex metacharacters is matched LITERALLY, not as a pattern",
];

/** Prose that does NOT contain `src/(legacy).ts` but matches it once the path
 * is interpolated into the pattern UNESCAPED: `(legacy)` then collapses to an
 * EMPTY CAPTURE GROUP and the dots become single-character wildcards, so
 * `srccclegacycts` — `ccc` and `cts` standing in for the two three-character
 * wildcard runs around the now-empty group — satisfies the pattern while
 * containing no such file. Expected: NOT accounted. This is the assertion that
 * makes `META_CITED` a real one: a dot-only escape makes the positive case
 * green for the wrong reason and this one red for the right one. */
export const META_UNESCAPED_FIT: [string, string, "summary" | undefined, string] = [
  "Reviewed srccclegacycts and fixed it",
  "src/(legacy).ts",
  undefined,
  "a metacharacter path is not matched by text that merely fits its UNESCAPED pattern (an empty capture group plus two wildcard runs)",
];

export const TEST_FLANK_ESCAPE_CASES: readonly [string, string, "summary" | undefined, string][] =
  [NL_OPEN, META_CITED, META_UNESCAPED_FIT];
