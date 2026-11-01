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
 * restore: `ec2f4039`). The `\n|`-deletion row, the exclude-newline row and
 * the `^`-deletion row were re-measured against the post-deletion file,
 * restored the same way (`be64095a` after the last restore). Verdicts below
 * are what the run printed; nothing here is claimed from reasoning.
 *   - delete `\n|` from the left flank        → suite stays GREEN (P: 5 F: 0),
 *     which is the redundancy proof: the alternative was unreachable, so no
 *     fixture could redden on its removal. (2026-11-03, after the header above
 *     was written; the earlier claim in this block — "REDS: NL_OPEN alone" —
 *     was measured never to hold and is corrected here.)
 *   - exclude `\r`/`\n` from `NOT_PATH` while the `\n|` arm was still present
 *     (`[^A-Za-z0-9_./+\-\r\n]`) → NL_OPEN stayed GREEN (P: 1 F: 0): the
 *     explicit `\n` alternative was carrying it. That row and the one below
 *     are the pair that identifies what the fixture witnesses — take away
 *     BOTH ways the left flank can match a newline (the arm, and the negated
 *     class) and only then does it go red.
 *   - exclude `\r`/`\n` from `NOT_PATH` in the POST-DELETION file (`[^A-Za-z0-9_./+\-\r\n]`, i.e. make
 *     the left flank NOT match a newline) → NL_OPEN **FAILS** (`P: 0 F: 1`,
 *     the only red is the NL_OPEN canary). So `NL_OPEN` DOES witness something:
 *     it witnesses that the left flank admits a line-initial path — which, now
 *     the `\n|` alternative is gone, is `NOT_PATH`'s job. `^` does NOT rescue
 *     it: `^` matches only at index 0, and NL_OPEN's left boundary is index 19,
 *     which `NOT_PATH` admits.
 *     Conclusion: the fixture is
 *     not decoration (it can go red), but what it witnesses is the negated
 *     class, not a dedicated arm.
 *   - delete `^` from the left flank — left flank becomes `(?:NOT_PATH)`, i.e.
 *     the flank requires a character before the path — → 4 of
 *     `test-lens-coverage-denominator.ts`'s
 *     60 assertions go RED: the plain-citation cases at `:78`, `:89` and `:152`
 *     (left neighbour is a SPACE) and one case outside this suite. NONE of them
 *     has its path's left boundary at index 0. So **no case in the whole suite
 *     is `^`-exclusive**: every path its left flank reaches is also reachable
 *     through `NOT_PATH`, and the `^` alternative is currently un-witnessed.
 *     `CARET_OPEN` below was written to close exactly this gap and did NOT
 *     close it — see that fixture's rationale. (2026-11-03.)
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
  "a path at the start of a line opens a citation — the line-initial position is admitted by the negated NOT_PATH class, which matches a newline",
];

/** A denominator path whose left boundary is index 0 of the summary (a sole
 * leading newline, then the path, so no non-newline character sits before it).
 * Expected: accounted.
 *
 * **DECORATION — it witnesses nothing.** The intent was to give the `^`
 * left-flank alternative its own case, on the theory that `NOT_PATH` needs a
 * character to consume and at index 0 there is none. Measured 2026-11-03 that
 * theory does not survive the run: this case is GREEN with the shipped
 * `(^|NOT_PATH)` flank and GREEN with `^` deleted, so no mutation of the left
 * flank distinguishes it from its neighbours. Two reasons it cannot, and both
 * are why an index-0 fixture is the wrong shape for `^`: the leading `\n` is
 * itself a `NOT_PATH` character sitting at index 0, so the flank can consume it
 * and reach the path at index 1 without the anchor; and any summary whose path
 * truly starts at index 0 is matched by `^` *and* — if anything precedes it —
 * by `NOT_PATH`, because the two arms partition only at index 0, where there is
 * nothing to partition. It is kept, labelled, because the behaviour it states is
 * true and cheap to keep; it is NOT cited as proof that `^` is load-bearing, and
 * the `^` alternative remains un-witnessed (see the `^`-deletion row above). */
export const CARET_OPEN: [string, string, "summary" | undefined, string] = [
  "\nsrc/c.ts is fine",
  "src/c.ts",
  "summary",
  "a path at the start of the summary is a citation — DECORATION: green with `^` and green without it, so it does not witness the `^` arm",
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
  [NL_OPEN, CARET_OPEN, META_CITED, META_UNESCAPED_FIT];
