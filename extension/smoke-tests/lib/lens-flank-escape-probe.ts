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
 * against `mentionsPath` by editing `lens-review-coverage.ts`, running the cases,
 * and restoring the file byte-identically (`git hash-object` matched the blob it
 * started from after every restore). Each row names its own BEFORE-STATE by blob,
 * and the two hashes this block carries name two DIFFERENT files: `ec2f4039` is
 * the pre-deletion `lens-review-coverage.ts` (its flank still reads
 * `(?:^|\n|${NOT_PATH})`, blob of commit `80169608`'s parent) and `be64095a` is
 * the file AFTER the `\n|` alternative was deleted (`(?:^|${NOT_PATH})`, the blob
 * `80169608` itself shipped). An earlier revision cited them as one restore
 * pair, which made the `\n|` row read as measured on a tree that had already lost
 * the arm — a redundancy proof about a file with no arm to prove redundant. Each
 * row below names its own before-state; `be64095a` is cited only for the rows
 * measured on the post-deletion file.
 *   - delete `\n|` from the left flank (before-state `ec2f4039`, the file that
 *     still carries the arm) → suite stays GREEN (`P: 5 F: 0`). The figure is
 *     the flank-escape block's own printed assertion count — five lines, and a
 *     `grep -c` of the block confirms five, so the number is checkable rather than
 *     remembered. WHAT THE ROW DOES NOT CLAIM, stated because an earlier revision
 *     claimed more of it: a GREEN run is the EXPECTED result of deleting a
 *     redundant arm and is therefore not by itself evidence the arm was ever
 *     there — measuring the ADDITION of an arm product code never had prints the
 *     identical `P: 5 F: 0` and proves the same nothing. The witness that actually
 *     identifies the arm is the PAIR below: exclude newline from `NOT_PATH` with
 *     the arm present and `NL_OPEN` is green; in the post-deletion file it is the
 *     only red. That pair moves, and `NL_OPEN` is the fixture both halves read.
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
 *   - delete `^` from the left flank — the flank becomes `(?:NOT_PATH)`, which
 *     REQUIRES a character before the path — → **3** of
 *     `test-lens-coverage-denominator.ts`'s assertions go RED. Re-measured by
 *     deleting the anchor in a complete repo-root scratch copy and running the
 *     file directly: 3 RED, every other printed assertion GREEN, identical across
 *     two runs. The reds are named by their own text, never by a line number: this
 *     row once cited `:79`, `:84`, `:88` and a loop at `:427`, and `:427` could not
 *     have existed in a 325-line file. It also published "3 of 64", where the 64
 *     was a printed-line count that a `grep -c` of `assert(` contradicted at 54.
 *     A line number and a file total are both claims about a snapshot; the
 *     assertion text below is a claim about the code, and the 3 is the figure the
 *     argument rests on.
 *       1. `a closing summary naming the file accounts for it`
 *       2. `canary: the file NO evidence mentions is the unaccounted one —
 *          before this gate it was invisible`
 *       3. `canary: a path that starts the summary itself is a citation — the
 *          one position NOT_PATH cannot supply a neighbour for ("src/c.ts is
 *          fine")` — the `CARET_OPEN` case below
 *     Cases 1 and 2 are the two assertions over the ONE summary
 *     `"src/b.ts is fine as written."`: that string's only
 *     mention of `src/b.ts` starts at index 0, so the same mutant reddens both
 *     halves of that block together. They are distinguishable from case 3 by
 *     their own text — a red that quotes a summary is `CARET_OPEN`, a red that
 *     names no summary is one of the two assertions over that summary. `CARET_OPEN` is the
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
 * (0 reds in `test-lens-coverage-denominator.ts` and `test-lens-coverage-routing.ts`).
 * What follows from that: THIS fixture cannot witness the `-` member of
 * `TERMINATOR`, because `expected: undefined` can never show WHICH right-flank
 * arm refused the path.
 * The deleted line here read "because the lookahead is what refuses it", and the
 * replacement that follows asserts the opposite for a shape no fixture covered at
 * the time it was written. Both were reasoning. Now measured on a scratch copy:
 * deleting `\-` from `TERMINATOR` leaves THIS fixture `undefined` (the lookahead
 * still refuses it), and deleting the lookahead leaves it `undefined` too (the
 * terminator arm still refuses it) — so "both arms refuse it" is what the run
 * printed, and it is what the `why` below now says. What the run ALSO printed,
 * which is the reason this fixture cannot be the `-` witness, is that
 * `TERMINATOR_HYPHEN` reddens on the `TERMINATOR` deletion and this one does not:
 * a negative-only fixture has no way to name the arm, and `TERMINATOR_HYPHEN` is
 * the positive one that does.
 *
 * PER-MEMBER DELETION, BOTH FANKS — driven by `lens-class-mutants.ts`, which
 * PARSES the class into tokens, removes the named member, and REFUSES the run
 * unless the mutant differs from shipped, still compiles as a class, and genuinely
 * stops matching the deleted member. Every row below is that generator's OUTPUT
 * with a run's red count beside it, and the shipped blob
 * (`e24a34029a23922515b2cd7d348d2472e11dd400`, equal to
 * `git rev-parse HEAD:extension/src/lens-review-coverage.ts`) was re-hashed after
 * every restore and matched every time.
 *
 * THESE COUNTS ARE A RUN, NOT A TRANSCRIPTION — and `test-lens-class-mutants.ts`
 * asserts it: its reconciliation block re-runs `measuredTable` for every member
 * and refuses the suite unless each number here matches what the harness printed
 * this run. A future fixture that shifts a count reddens that assertion instead of
 * leaving this header describing a table nobody printed. (The figures below were
 * re-measured with `lib/lens-mutant-harness.ts` on the shipped tree after the
 * `
`-boundary fixtures and the paired sibling fixtures were added, which
 * moved several rows off the single-witness numbers an earlier revision printed.)
 *
 * WHAT `reds` COUNTS: failing fixtures in `lib/lens-mutant-harness.ts`'s CORPUS
 * driven through `runMutant` — the harness's own reimplementation of the shipped
 * `mentionsPath` template, gated byte-for-byte against the product by
 * `assertHarnessFidelity`. It is NOT the three coverage suites' assertion counts
 * an earlier revision described; those suites run the real `accountedFiles`, and
 * the harness exists precisely so a mutant can be measured without mutating
 * `lens-review-coverage.ts`. A fixture appears in a row's count when deleting
 * that member flips its verdict.
 *
 * THE TABLE HAS TWO SIDES, and that is the whole point of this section.
 * `mentionsPath` interpolates `PATH_CHAR` (the right-flank lookahead), `NOT_PATH`
 * (the left flank), `TERMINATOR` (the anchored arm) and `NOT_LINE_BREAK` — and
 * `PATH_CHAR`/`NOT_PATH` are `PathCharClass` mirrors of one set. The version of
 * this table that first shipped measured `PATH_CHAR` only and printed a single
 * verdict "for the class", so `NOT_PATH` minus `+` was invisible, and every `0` on
 * it was a statement about one of two constants. The harness is
 * `lib/lens-mutant-harness.ts`; the fixtures are
 * `lib/lens-flank-escape-probe.ts` and `lib/lens-left-flank-probe.ts`.
 *
 * `NOT_LINE_BREAK` has no per-member row here and that is stated, not hidden: its
 * class is negated, so `mutantsFor` refuses every single-member deletion of it as
 * an admits-everything case — a `0`/`N` row would be a figure the generator
 * refuses to produce. It is nevertheless a live class the corpus can redden: the
 * lone-CR boundary fixtures below flip their verdict the moment NOT_LINE_BREAK
 * loses its carriage-return member, and `assertHarnessFidelity` refuses the whole harness if the
 * class literal, the escape regex, or the template drift from the product.
 *
 * A control run proves the harness can redden at all, and which half of "the
 * harness works" it proves: substituting the shipped class bytes for themselves
 * prints **0**, and `PATH_CHAR` minus a member prints a non-zero count in the same
 * harness. `test-lens-class-mutants.ts` asserts both halves. A control that only
 * ever prints 0 says nothing — the pair is the evidence.
 *
 * THERE IS NO TRANSCRIBED TABLE HERE, ON PURPOSE. An earlier revision of this
 * header published a `member → class → reds → witness` grid. It was a second
 * source of truth: the numbers were copied out of a run into a comment, and every
 * fixture added since then silently rotted them — the `0`/"UNPINNED" TERMINATOR
 * rows, the "seven"/"six" NOT_PATH counts, the "1"s for every PATH_CHAR member,
 * all disagreed with what `measuredTable` prints today. A table nobody executes is
 * the defect this branch exists to close, so the grid is DELETED rather than
 * re-transcribed with fresher numbers. THE TABLE IS `test-lens-class-mutants.ts`:
 * its reconciliation block calls `measuredTable(flank)` for each of
 * `PATH_CHAR`/`NOT_PATH`/`TERMINATOR`, re-runs every generated mutant over the
 * harness CORPUS, and REFUSES the suite unless each published figure matches the
 * run. To see the table, run that file; to change it, add a fixture and let the
 * assertion tell you which row moved. `reds` counts failing CORPUS fixtures under
 * `runMutant` (the harness's fidelity-gated copy of `mentionsPath`), not the three
 * coverage suites' assertion counts an earlier revision described.
 *
 * POSITION DEPENDENCE decides whether a mutant is visible at all: in
 * `See src/b.ts+` and `See src/b.ts/` the metacharacter is TERMINAL, so the
 * `NOT_LINE_BREAK(?!PATH_CHAR)` arm has nothing to close on and only the
 * lookahead decision remains. Give the same character a follower
 * (`See src/b.ts+spec`) and the non-line-break arm closes on `s`, making the
 * mutant invisible to a fixture spelled that way. The `"…b.ts+spec"` and
 * `"…b.ts/spec"` probes the old table named DO NOT EXIST as fixtures and were
 * never run; they are removed rather than kept as decoration — a table promising
 * probes that do not exist is the same defect as a fabricated red. */
export const PATH_CHAR_HYPHEN: [string, string, "summary" | undefined, string] = [
  "See src/b.ts-spec",
  "src/b.ts",
  undefined,
  "a path followed by a hyphenated suffix is not a citation of the shorter file — `-` is a PATH_CHAR, and also a TERMINATOR, so BOTH right-flank arms refuse it (witness: red when the `-` range endpoint is dropped from PATH_CHAR; the `-` escape must stay or the class is invalid)",
];

/** The `+` member of `PATH_CHAR`, pinned by an ASSERTION rather than only by
 * the matcher. Measured with the parsed-token generator on a complete repo-root
 * scratch copy: deleting `+` from `PATH_CHAR` reddens exactly ONE assertion across
 * the three coverage suites — this one — so without it the member is unpinned.
 * Deleting `+` from `NOT_PATH`, which the same generator produces and the earlier
 * table never ran, reddens SIX. Two limits this states:
 * the metacharacter must be TERMINAL (with a follower, `See src/b.ts+spec`, the
 * `NOT_LINE_BREAK(?!PATH_CHAR)` arm closes on `s` and the mutant is invisible),
 * and "the ONLY assertion" is a claim about
 * `test-lens-coverage-denominator.ts` specifically — the routing suite stays
 * green under this mutant. */
export const PATH_CHAR_PLUS: [string, string, "summary" | undefined, string] = [
  "See src/b.ts+",
  "src/b.ts",
  undefined,
  "a path followed by a terminal `+` is not a citation of the shorter file — `+` is a PATH_CHAR so the lookahead refuses to close (witness: the ONLY assertion in `test-lens-coverage-denominator.ts` that reddens when `+` is deleted from PATH_CHAR; routing stays green; the `+` must be terminal or the non-line-break arm closes and the mutant is invisible)",
];

/** The `/` member of `PATH_CHAR`, pinned by an ASSERTION. Measured 2026-11-04:
 * deleting `/` reddens exactly ONE assertion across both coverage suites — this
 * one — so this case is its only witness; the trailing slash is a path
 * character, not a terminator, so the lookahead is the arm that refuses it
 * (deleting the TERMINATOR arm instead flips this fixture to `summary`, which is
 * what identifies the lookahead as the witness rather than the terminator).
 * Terminal position is load-bearing for the same reason as `PATH_CHAR_PLUS`, and
 * "the ONLY assertion" names `test-lens-coverage-denominator.ts` — routing stays
 * green. */
export const PATH_CHAR_SLASH: [string, string, "summary" | undefined, string] = [
  "See src/b.ts/",
  "src/b.ts",
  undefined,
  "a path followed by a terminal slash is not a citation of the shorter file — `/` is a PATH_CHAR so the lookahead refuses to close (witness: the ONLY assertion in `test-lens-coverage-denominator.ts` that reddens when `/` is deleted from PATH_CHAR; routing stays green; the slash must be terminal or the non-line-break arm closes and the mutant is invisible)",
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
