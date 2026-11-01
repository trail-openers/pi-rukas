/**
 * lens-flank-escape-probe — the two alternatives of `mentionsPath` that every
 * other coverage fixture leaves unpinned.
 *
 * `mentionsPath` in `lens-review-coverage.ts` is
 * `(?:^|\n|NOT_PATH)ESCAPED(?:(?!PATH_CHAR)NOT_LINE_BREAK|TERMINATOR?(?:\r?\n|$))`.
 * Two of its parts were mutation-invisible before these cases:
 *
 *   - the LEFT flank's `\n` alternative. NO case in this file witnesses it,
 *     and none can: deleting `\n|` from the alternation leaves the whole
 *     coverage suite green, and widening `NOT_PATH` back to include `\n` does
 *     too (both measured, 2026-11-XX — see MUTATION PROOF below). The reason
 *     is in the shipped regex, not in the fixtures: the right flank's
 *     `NOT_LINE_BREAK` is `[^\r\n]`, and the left flank's `NOT_PATH` is a
 *     NEGATED class, so both already match a newline. A bare `\n` left
 *     neighbour therefore satisfies the LEFT flank through `NOT_PATH` no matter
 *     whether the `\n|` alternative exists. `NL_OPEN` is kept because a bare
 *     newline-flanked citation must keep accounting, but it is NOT evidence
 *     that the `\n|` arm is reachable, and a future reader must not cite it as
 *     such. Making the arm reachable means making the two flank classes
 *     actually disjoint, which the product does not currently do.
 *   - the escape class `[.*+?^${}()|[\]\\]`. Every denominator path in the
 *     other fixtures is regex-inert, so narrowing the class to `/\./g` passed
 *     the whole suite before these cases existed. `src/(legacy).ts` is not
 *     inert: unescaped, `(legacy)` collapses to an EMPTY CAPTURE GROUP and
 *     each `.` becomes a SINGLE-character wildcard (one character, not a run —
 *     the earlier version of this header said "runs", which is why its
 *     fixture could never match), so `META_UNESCAPED_FIT` supplies text that
 *     fits the UNESCAPED pattern while never naming the file. That negative
 *     case is what makes `META_CITED` a real one: with a dot-only escape the
 *     positive case can still be satisfied by an over-permissive match, and
 *     the negative case is the one that says so.
 *
 * MUTATION PROOF — measured 2026-11-XX against the shipped `mentionsPath`,
 * each by editing `lens-review-coverage.ts`, running the cases, and restoring
 * the file byte-identically (`git hash-object` matched HEAD's blob after every
 * restore). Verdicts below are what the run printed; nothing here is claimed
 * from reasoning.
 *   - delete `\n|` from the left flank        → REDS: NL_OPEN alone.
 *   - widen `NOT_PATH` to include `\r`/`\n`   → REVERSES the above: NL_OPEN
 *     greens again. This is the measurement that KILLS the claim that
 *     `NL_OPEN` witnesses the arm: if a fixture witnessed an alternative,
 *     making that alternative redundant could not silence it. It did, so the
 *     arm is dead code kept for future-proofing, not a covered branch.
 *   - narrow the escape class to `/\./g`      → REDS: META_CITED **and**
 *     META_UNESCAPED_FIT (2 red). An earlier version of this header asserted
 *     the opposite — "META_CITED stays green, which is the point of pairing
 *     them" — and that was measured never to hold: the pairing is worth
 *     having, but BOTH halves move, so neither is the canary for the other.
 *   - remove the escape entirely (`file` raw) → REDS: META_CITED and
 *     META_UNESCAPED_FIT again, and META_UNESCAPED_FIT's OLD text
 *     (`"Reviewed srccclegacycts and fixed it"`) stays GREEN under all three
 *     regimes — shipped, dot-only, and unescaped. It could never fail: the
 *     unescaped pattern needs a literal `/` and `srccclegacycts` has none, and
 *     `.` is a one-character wildcard, so the 14-character string cannot fill
 *     a 15-character pattern. An assertion that cannot go red under any
 *     mutation of the code it tests is not a test.
 *
 * Each case is `[summary, denominatorFile, expectedClaim, why]`; the test
 * asserts `accountedFiles([row({ summary })], new Set([file]))?.get(file)`.
 * The denominators here are single-file sets on purpose: these cases pin how a
 * path is MATCHED, not what the round's denominator is, and a one-file set
 * keeps a red assertion unambiguous about which flank moved.
 */

/** A citation whose ONLY left boundary is the start of a line: the character
 * before `src/c.ts` is `\n` and nothing else — no bullet, no colon, no space.
 * Expected: accounted (`summary`). KEEP THIS CASE: a bare newline-flanked
 * citation must keep accounting. But it does NOT witness the `\n|` alternative
 * — deleting that arm leaves it green, because the negated `NOT_PATH` class
 * matches a newline too (see MUTATION PROOF above). Do not describe it as
 * pinning that arm. */
export const NL_OPEN: [string, string, "summary" | undefined, string] = [
  "Reviewed the delta.\nsrc/c.ts is fine",
  "src/c.ts",
  "summary",
  "a path at the start of a line opens a citation on the \\n flank alone — no bullet, no non-path character in front",
];

/** The same path, spelled with regex metacharacters, cited as itself.
 * Expected: accounted. Red when the escape class narrows to a dot only, and
 * red when it is removed — the SAME two mutations that redden
 * `META_UNESCAPED_FIT`, so this is a companion, not the pair's control. */
export const META_CITED: [string, string, "summary" | undefined, string] = [
  "Reviewed src/(legacy).ts and fixed it",
  "src/(legacy).ts",
  "summary",
  "a denominator path containing regex metacharacters is matched LITERALLY, not as a pattern",
];

/** Prose that does NOT contain `src/(legacy).ts` but matches it once the path
 * is interpolated into the pattern UNESCAPED: `(legacy)` collapses to an EMPTY
 * CAPTURE GROUP and each `.` becomes a SINGLE-character wildcard, so this text
 * — which reuses the literal `src/` and `legacy` and spends exactly one
 * character on each dot position — satisfies the unescaped pattern while
 * naming no such file. Expected: NOT accounted. Measured to redden under both
 * the dot-only narrowing and full removal of the escape (the old
 * `srccclegacycts` fixture never reddened under any regime). */
export const META_UNESCAPED_FIT: [string, string, "summary" | undefined, string] = [
  "see src/legacy.ts now",
  "src/(legacy).ts",
  undefined,
  "a metacharacter path is not matched by text that merely fits its UNESCAPED pattern (an empty capture group plus two single-character wildcards)",
];

export const TEST_FLANK_ESCAPE_CASES: readonly [string, string, "summary" | undefined, string][] =
  [NL_OPEN, META_CITED, META_UNESCAPED_FIT];
