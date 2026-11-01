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
 *     the flank requires a character before the path — → **3** of
 *     `test-lens-coverage-denominator.ts`'s
 *     64 assertions go RED (re-measured 2026-11-03 by deleting the anchor in a
 *     scratch copy and running the file directly: 64 GREEN under the shipped
 *     file, 61 GREEN + 3 RED under the mutant, reproduced on two runs; the 64
 *     is the number of lines the harness prints — `bun ./smoke-tests/…` prints
 *     one `✓`/`✗` per `assert` that executes, four of them from the
 *     `TEST_FLANK_ESCAPE_CASES` loop at `:427`, which a `grep -c` of `assert(`
 *     under-counts as 54 — so it is a printed-line count, not a hand count).
 *     The three reds, verbatim from the run:
 *       1. `a closing summary naming the file accounts for it` (`:84`)
 *       2. `canary: the file NO evidence mentions is the unaccounted one —
 *          before this gate it was invisible` (`:88`)
 *       3. `canary: a path that starts the summary itself is a citation — the
 *          one position NOT_PATH cannot supply a neighbour for ("src/c.ts is
 *          fine")` — the `CARET_OPEN` case below
 *     Cases 1 and 2 are the two assertions over the ONE summary
 *     `"src/b.ts is fine as written."` (the file at `:79`): that string's only
 *     mention of `src/b.ts` starts at index 0, so the same mutant reddens both
 *     halves of that block together. They are distinguishable from case 3 by
 *     their own text — a red that quotes a summary is `CARET_OPEN`, a red that
 *     names no summary is one of the two `:79` assertions. `CARET_OPEN` is the
 *     `^`-exclusive one and the witness: GREEN with `^`, RED with `^` deleted,
 *     while `NL_OPEN` — path at index 19, a `\n` neighbour `NOT_PATH` consumes
 *     — stays GREEN under the same mutant. It was not a witness until its
 *     summary lost a leading `\n` — see that fixture's rationale. The "4" this
 *     row carried came from a regime whose fourth red sat outside the five
 *     files this gate runs; no run of this file, under either spelling of the
 *     file-level count, has produced a fourth. (2026-11-03.)
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

/** A denominator path whose left boundary is index 0 of the summary: the path
 * IS the opening text, so there is no character for `NOT_PATH` to consume.
 * Expected: accounted.
 *
 * **WITNESS for the `^` left-flank alternative** — the only case in the suite
 * that is. Measured 2026-11-03 (scratch tree, `lens-review-coverage.ts` copied
 * aside and restored byte-identically; the shipped file's blob hash matched
 * HEAD before and after every run): GREEN under the shipped `(?:^|NOT_PATH)`
 * flank, **RED** with the `^` alternative deleted, and `NL_OPEN` — whose path
 * starts at index 19 with a `\n` neighbour that `NOT_PATH` consumes — stayed
 * GREEN under the same mutant. The earlier version of this fixture carried a
 * leading `\n` (`"\nsrc/c.ts is fine"`), which put the path at index 1 where a
 * `NOT_PATH` character does sit, and measured GREEN under both regimes; that
 * `\n` is what made it a decoration, not the shape. `^` is the ONLY way the
 * flank can reach this path: at index 0 there is nothing for the negated class
 * to consume. */
export const CARET_OPEN: [string, string, "summary" | undefined, string] = [
  "src/c.ts is fine",
  "src/c.ts",
  "summary",
  "a path that starts the summary itself is a citation — the one position NOT_PATH cannot supply a neighbour for (witness: red when the `^` flank arm is deleted)",
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

/** A denominator path followed by MORE path characters where the extra run is
 * spelled with the HYPHEN: `src/b.ts-spec` is a different file, not `src/b.ts`
 * with a `-` on it. The right flank's lookahead reads `PATH_CHAR`, and `-` is
 * one of that class's own characters — with `-` in the class the path cannot
 * close and this is NOT a citation; drop `-` from `PATH_CHAR` and the lookahead
 * no longer sees the `-`, so the very next character satisfies it and this
 * returns `summary`.
 *
 * **WITNESS for the `-` member of `PATH_CHAR`** — the only case in the suite
 * that is. Measured: GREEN under the shipped class, RED with `-` deleted from
 * `PATH_CHAR` (the deletion must drop the trailing range endpoint, not the
 * `\-` escape — dropping the escape instead yields an invalid character class
 * and no witness at all).
 *
 * What this case does NOT establish, stated because an earlier version of this
 * header got it backwards: `-` is refused here by BOTH right-flank arms, not by
 * the lookahead alone. `TERMINATOR` is `[!?,.;:\-]` and contains `-`, so the
 * anchored-terminator arm refuses `src/b.ts-spec` too. Measured on a scratch
 * copy with the terminator arm deleted from the alternation (leaving the
 * lookahead) and with the lookahead deleted (leaving the terminator arm): this
 * fixture stays `undefined` under EITHER arm alone. Deleting `\-` from
 * `TERMINATOR` leaves this fixture and the whole `PATH_CHAR` question green
 * (0 reds in `test-lens-coverage-denominator.ts` and `test-lens-coverage-routing.ts`),
 * because the lookahead is what refuses it.
 *
 * PER-MEMBER `PATH_CHAR` DELETION — measured 2026-11-04 on a COMPLETE repo-root
 * scratch copy (`/tmp/lcov-d`, `extension/` plus the sibling `skill/` that
 * `BUNDLED_SKILL_DIR` resolves through), with the mutated blob hash printed per
 * run and the shipped blob re-hashed after each restore. "suite reds" = failing
 * assertions in `test-lens-coverage-denominator.ts` + `test-lens-coverage-routing.ts`
 * (the only two coverage suites); "probe" = discriminating one-line fixtures
 * under that mutant that the shipped class gets right, which is the ONLY signal
 * for the two members no assertion reads.
 *
 *   member  class becomes        suite reds  probe
 *   `+`     `[A-Za-z0-9_./+-]`→   0           `"See src/b.ts+"` and `"…b.ts+spec"` flip to `summary`
 *           `[A-Za-z0-9_./+-]`                 (matcher moves, NO assertion did)
 *   `/`     →`[A-Za-z0-9_.+-]`    0           `"See src/b.ts/"` and `"…b.ts/spec"` flip (same)
 *   `.`     →`[A-Za-z0-9_/+-]`    1           `"See src/b.ts.spec"` flips
 *   `-`     →`[A-Za-z0-9_./+-]`    0           none — `TERMINATOR` still refuses it
 *           (range endpoint,                     (witnessed only via the `-spec` case)
 *            escape kept)
 *   word    (delete `A`/`9` etc.) 0           not measured separately
 *
 * Those "0 suite reds" for `+` and `/` are why `PATH_CHAR_PLUS` and
 * `PATH_CHAR_SLASH` exist below: with those two fixtures added, the SAME two
 * mutants each redden exactly ONE assertion in
 * `test-lens-coverage-denominator.ts` (measured with the fixtures present —
 * `+` → "a path followed by `+` is not a citation…", `/` → "a path followed by
 * a trailing slash…"), so both members are now pinned by an assertion rather
 * than only by the raw matcher. Before the fixtures, deleting either moved no
 * test in either coverage suite.
 *
 * The one real suite red the `.` mutant moved was already there, and it fires
 * in BOTH suites: `test-lens-coverage-denominator.ts` "canary: the terminator
 * arm does not turn a LONGER path into a citation of a shorter one", and
 * `test-lens-coverage-routing.ts` "(g1) the quoted recital accounts for nothing
 * — both files stay DISCLOSED". It is NOT a lookahead witness: deleting `.`
 * from `TERMINATOR` instead reddens two different assertions (the
 * "ends a SENTENCE still accounts" pair), so `.` is pinned through the
 * TERMINATOR arm, not `PATH_CHAR`. The `-` member of `TERMINATOR` is not pinned
 * by any assertion in either coverage suite (0 reds), because the `PATH_CHAR`
 * lookahead refuses `src/b.ts-spec` first. */
export const PATH_CHAR_HYPHEN: [string, string, "summary" | undefined, string] = [
  "See src/b.ts-spec",
  "src/b.ts",
  undefined,
  "a path followed by a hyphenated suffix is not a citation of the shorter file — `-` is a PATH_CHAR, and also a TERMINATOR, so BOTH right-flank arms refuse it (witness: red when the `-` range endpoint is dropped from PATH_CHAR; the `-` escape must stay or the class is invalid)",
];

/** The `+` member of `PATH_CHAR`, pinned by an ASSERTION rather than only by
 * the matcher. Deleting `+` from the class (the trailing range endpoint, escape
 * kept) leaves BOTH coverage suites green — see the per-member table on
 * `PATH_CHAR_HYPHEN` — so without this case the member is unpinned. With `+` in
 * the class the lookahead refuses to close and this is NOT a citation. */
export const PATH_CHAR_PLUS: [string, string, "summary" | undefined, string] = [
  "See src/b.ts+",
  "src/b.ts",
  undefined,
  "a path followed by `+` is not a citation of the shorter file — `+` is a PATH_CHAR so the lookahead refuses to close (witness: the ONLY assertion that reddens when `+` is deleted from PATH_CHAR; the suites alone stay green)",
];

/** The `/` member of `PATH_CHAR`, pinned by an ASSERTION. Deleting `/` from the
 * class leaves both coverage suites green, so this case is the only witness;
 * the trailing slash is a path character, not a terminator, so the lookahead is
 * the arm that refuses it. */
export const PATH_CHAR_SLASH: [string, string, "summary" | undefined, string] = [
  "See src/b.ts/",
  "src/b.ts",
  undefined,
  "a path followed by a trailing slash is not a citation of the shorter file — `/` is a PATH_CHAR so the lookahead refuses to close (witness: the ONLY assertion that reddens when `/` is deleted from PATH_CHAR)",
];

export const TEST_FLANK_ESCAPE_CASES: readonly [string, string, "summary" | undefined, string][] = [
  NL_OPEN,
  CARET_OPEN,
  META_CITED,
  META_UNESCAPED_FIT,
  PATH_CHAR_HYPHEN,
  PATH_CHAR_PLUS,
  PATH_CHAR_SLASH,
];
