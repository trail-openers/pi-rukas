/**
 * lens-flank-escape-probe — the parts of `mentionsPath` that every other
 * coverage fixture leaves unpinned.
 *
 * `mentionsPath` in `lens-review-coverage.ts` is
 * `(?:^|NOT_PATH)ESCAPED(?:(?!PATH_CHAR)NOT_LINE_BREAK|TERMINATOR?(?:\r?\n|$))`.
 * Two of its parts were mutation-invisible before these cases:
 *
 *   - the LEFT flank. There is NO dedicated `\n` alternative and never should
 *     be read into one: the left flank is `(^|NOT_PATH)`, and `NOT_PATH` is a
 *     NEGATED class (`[^A-Za-z0-9_./+-]`) that already matches a newline. A
 *     bare `\n` left neighbour therefore satisfies the LEFT flank through
 *     `NOT_PATH` (or, at the very start of the summary, through `^`). The
 *     `\n|` alternative that used to sit in that alternation was UNREACHABLE
 *     product code and is deleted (2026-11-03 — see MUTATION PROOF below);
 *     deleting it left the whole coverage suite green. `NL_OPEN` is kept as a
 *     `BEHAVIOUR pin — a citation whose only left boundary is a line start must
 *     keep accounting — and is NOT evidence for any separate arm. It is not
 *     decoration either: excluding newline from `NOT_PATH` reddens it (see
 *     MUTATION PROOF below).
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
 * MUTATION PROOF — the `NOT_PATH` and escape-class rows below were measured
 * 2026-11-01 against the shipped `mentionsPath`, each by editing
 * `lens-review-coverage.ts`, running the cases, and restoring the file
 * byte-identically (`git hash-object` matched HEAD's blob after every
 * restore: `ec2f4039`). The `\n|`-deletion row and the exclude-newline row
 * were re-measured against the post-deletion file, restored the same way.
 * Verdicts below are what the run printed; nothing here is claimed from
 * reasoning.
 *   - delete `\n|` from the left flank        → suite stays GREEN (P: 5 F: 0),
 *     which is the redundancy proof: the alternative was unreachable, so no
 *     fixture could redden on its removal. (2026-11-03, after the header above
 *     was written; the earlier claim in this block — "REDS: NL_OPEN alone" —
 *     was measured never to hold and is corrected here.)
 *   - exclude `\r`/`\n` from `NOT_PATH` (`[^A-Za-z0-9_./+\-\r\n]`, i.e. make
 *     the left flank NOT match a newline) → NL_OPEN **FAILS** (`P: 4 F: 1`,
 *     the only red is the NL_OPEN canary). So `NL_OPEN` DOES witness something:
 *     it witnesses that the left flank admits a line-initial path — which, now
 *     the `\n|` alternative is gone, is `NOT_PATH`'s job. `^` does NOT rescue
 *     it, because the summary is `"Reviewed the delta.\nsrc/c.ts is fine"` and
 *     the path sits at index 19, nowhere near the `^` anchor at index 0 — so
 *     `^` had no way to reach it (and could not have matched anyway: the
 *     left-hand path characters preceding it are themselves in the path set).
 *     Conclusion: the fixture is
 *     not decoration (it can go red), but what it witnesses is the negated
 *     class, not a dedicated arm.
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
 * Expected: accounted (`summary`). KEEP THIS CASE: it pins the BEHAVIOUR that
 * a line-initial path is cited. It does NOT pin a dedicated `\n` flank arm —
 * the left flank is `(^|NOT_PATH)` and the negated `NOT_PATH` class matches a
 * newline, so that is what admits this path (see MUTATION PROOF above). Do not
 * describe it as pinning such an arm. */
export const NL_OPEN: [string, string, "summary" | undefined, string] = [
  "Reviewed the delta.\nsrc/c.ts is fine",
  "src/c.ts",
  "summary",
  "a path at the start of a line opens a citation — the line-initial position is admitted by the negated NOT_PATH class, which matches a newline (or by ^ at the very start)",
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
