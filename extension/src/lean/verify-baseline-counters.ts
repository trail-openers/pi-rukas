/**
 * lean/verify-baseline-counters — what a runner's line may MOVE by between two runs.
 *
 * The comparison half of the baseline excuse, split out from `verify-baseline-allow-list.ts`:
 * that file answers WHAT MAY BE EXCUSED (which head-only line is provably not a failure), this one
 * answers WHAT MAY MOVE (which fields of a line the two runs mean to be the same). The two are one
 * question seen from two sides — a runner's counters are exactly the fields a PR that adds passing
 * tests moves — so they share {@link COUNTER_WORD_LIST}, the closed set both read, and are read
 * together by {@link isKnownCleanLine} and {@link counterFolded}.
 *
 * The direction is the same as the allow-list's and it is the reason the list is closed: a digit is
 * folded ONLY when a counter or duration word sits immediately next to it, and a count of a word the
 * list has never heard keeps its digits. A fold that is too wide excuses a regression the base never
 * printed; a fold that is too narrow refuses the PR that only added passing tests. Enumerating
 * FAILURE words instead would fail the second way, because a failure vocabulary is unbounded —
 * `crashed`, `panicked`, `aborted`, `segfault`, and whatever the next runner adds — and every such
 * enumeration has produced a line that read as clean.
 *
 * The fold is confined to the looser comparison pass. The exact key in `normaliseRaw` keeps every
 * digit and is what `ci` RECORDS and replays; a fold that reached the record would turn a moved
 * failure count into an equality the base never printed.
 */

/**
 * The placeholder a folded field is replaced with.
 *
 * A character no runner prints (`#` is neither a digit nor a status word), so a real line can
 * never collide with a folded one and two lines that differ by content never collapse onto it.
 */
const PLACEHOLDER = "#";

/**
 * A digit run the runner printed as a COUNT or a TIMING, followed by its word.
 *
 * The fold is done by SPLITTING on digit runs and asking each one the same two questions about
 * the text around it, rather than by a chain of number-eating regexes: a regex fold either
 * swallows a failure count it must keep (the defect that makes `1 failed` equal `2 failed`) or
 * leaves a passing count standing (the defect that refuses the added-passing-tests case). A
 * digit run is folded ONLY when a counter or duration word sits immediately next to it —
 * `3 passed`, `2 skipped`, `5 tests`, `36 cases`, `2 warnings`, `5 total`, `1 warning`,
 * `2 xfailed`, `0.2s`, `1.5 seconds` — and keeps its digits everywhere else, which is what keeps
 * `assert 1 == 2`, `expected 3 to be 4`, a timestamp or a version standing as printed. A word
 * separated from the digits by any other character is not the word of THAT number.
 *
 * The digit runs of one line, as a fresh iterator each call.
 *
 * A module-level `/g` pattern asked through `matchAll` keeps `lastIndex` between calls, so the
 * SECOND line scanned resumes where the first stopped and its counters were read as already
 * folded — which is how `1 failed` and `2 failed` shared a key on every comparison after the
 * first. Building the pattern here, per line, is what keeps the scan stateless; no `test()` is
 * ever asked of a global pattern in this file.
 */
function digitRuns(line: string): RegExpStringIterator<RegExpExecArray> {
  return line.matchAll(/\d+(?:\.\d+)*/g);
}

/**
 * The words a runner counts that did NOT go wrong: `9 passed`, `2 skipped`, `5 tests`.
 *
 * THE list, exhaustive by closed-set design, spelled once here and assembled into every shape that
 * reads it — here for the fold, and in `verify-baseline-allow-list.ts` for the allow-list, which
 * imports it so the two cannot drift apart on which numbers a PR may move.
 *
 * The rule is INVERTED from the first version, which enumerated failure words and refused a count
 * attached to one of them. Failure vocabularies are unbounded — `crashed`, `panicked`, `aborted`,
 * `segfault`, and whatever the next runner adds — and every enumeration of them has produced a line
 * that read as clean: `999 crashed` folded away because a known counter word sat beside it, and a
 * run that crashed 998 times instead matched the tally the base printed as `999 crashed`. A count of
 * a word this list has never heard of keeps its digits and keeps its line off the allow-list, so a
 * new failure word is caught by being ABSENT and needs no change here to be caught — only to be
 * excused. A new legitimate counter word is the one edit either file should ever need.
 *
 * `pass`/`total`/`items`/`cases` are here because the tallies in the wild name their count that way
 * (`Tests: 5 passed, 5 total`, `36 cases`); `tests`/`items` count checks run rather than verdicts,
 * which is what lets the added-checks case move them. `failed`, `errors`, `crashed` and every other
 * report of what broke are deliberately not here.
 *
 * `ok` is NOT here, and that is load-bearing rather than an oversight. It would read as a harmless
 * alias for `passed`, but a TAP runner prints its CHECK INDEX immediately after that very word
 * (`not ok 2 - a bats check`), so `ok` in this list makes {@link COUNTER_WORD_BEFORE} — which asks
 * the word on the digit's left, precisely for a `Label: N` total — read the status word as the
 * index's label and fold it. `not ok 2` and `not ok 3` then share a counter key, and two different
 * failed checks become one line: the fold this module exists to refuse. A tally that counts in `ok`
 * (`6 ok`) reaches the allow-list's tally arm through its own shape, not through this list.
 */
export const COUNTER_WORD_LIST =
  "passed|pass|passes|skipped|skips|deselected|xfailed|xpassed|warnings?|tests?|items?|cases|total";

/**
 * The counter words a runner prints AFTER its number: `3 passed`, `2 skipped`, `5 tests`.
 *
 * These are the numbers a PR that ADDS PASSING TESTS moves, which is the field case the whole
 * tally allowance exists for: a suite already red at base gains two checks and its summary line
 * changes ONLY in the passing half (`1 failed, 3 passed` → `1 failed, 5 passed`). Read
 * byte-for-byte that is a head-only line, so an excuse that compared digits would refuse the one
 * case it grants. The words are {@link COUNTER_WORD_LIST} — ONE list for every reader — with the
 * leading whitespace of the fold's own slice in front of them, so the fold and the tally arm cannot
 * drift apart on what counts as a counter.
 */
const COUNTER_WORD_AFTER = new RegExp(`^\\s*(?:${COUNTER_WORD_LIST})(?![A-Za-z0-9])`, "i");

/** The same counter words printed BEFORE their number: `Tests: 5`, `Tests run: 3`, `Skipped: 0`. */
const COUNTER_WORD_BEFORE = new RegExp(
  `(?:^|[\\s(,;:=])(?:${COUNTER_WORD_LIST}|(?:tests\\s+)?run|ran)[\\s=:,;]*$`,
  "i",
);

/** A duration unit printed after its number: `0.2s`, `12ms`, `1.5 seconds`. */
const DURATION_AFTER = /^\s*(?:ms|s|sec|secs|seconds?|minutes?|hours?)(?![A-Za-z0-9])/i;

/**
 * A count whose word is a FAILURE word — `1 failed`, `Failures: 1`, `2 errors`.
 *
 * A narrow complement to {@link COUNTER_WORDS}, needed because the two mechanisms see different
 * halves of a tally. The counter list asks the word AFTER a number; the dialect the excuse must
 * fold — `1 failed, 3 passed` — writes its failure count as `N failed`, where "is the following
 * word a counter" sees `failed`, says no, and "is the preceding label a counter" sees nothing at
 * all. Without this arm `1 failed` folds to `# failed` and becomes the line the base printed as
 * `2 failed` — the one outcome the excuse exists to refuse.
 *
 * BOTH arms read the number and the word on its OWN side, and the label arm ends in `\s*\d` so the
 * word is adjacent to the digit it counts. A label that is merely REACHABLE from the number is not
 * the number's label, and three shapes this file has carried were reachable-but-wrong: the
 * comma-stretching `:[^,\r\n]*` branch, a `:?` that let a colon float free (`Failures: 3` and
 * `Failures 3` alike), and above all the unbounded `\s*` on the digit side, which read
 * `Tests run: 3, Failures: 1` as though `Failures:` were the label of the `3` three characters away
 * — holding the TOTAL the added-checks case exists to fold — and read `1 failed, 3 passed` as though
 * `failed,` were the label of the `3`, refusing the same case from the other side. `\s*\d` costs
 * `Failures 1` (a spelling no runner in this file's experience prints) and buys both field cases.
 *
 * A word list this short is safe to enumerate where the allow-list is not: an omission here refuses
 * a clean line, which costs a hand-back, while an omission in a failure vocabulary used for
 * PERMISSION is what produced every earlier round of this rule. Failure words the table has never
 * heard are caught by {@link UNKNOWN_COUNTED_WORD}, which refuses by absence.
 */
const FAILURE_COUNT =
  /[1-9]\d*\s+(?:failed|failing|failures?|errors?|fatal|critical)(?![A-Za-z0-9])/i;

/**
 * A tally's TOTAL — the count of how many checks ran, in its `Label: N` form.
 *
 * `Tests run: 3` and `Ran 5 tests` count checks, not verdicts, so the added-checks case moves
 * them and the excuse must not read them as evidence. They are folded on the digit's OWN text
 * rather than by {@link COUNTER_WORD_AFTER}, because the digit sits AFTER its label — past the
 * colon, where an adjacency test on the text after the number cannot reach it — and `run`/`ran`
 * cannot join {@link COUNTER_WORDS}, or `expected 5 to run 6 passed` would have its assertion
 * numbers folded. A `Failures:` or `Errors:` label is not in this list at all: its count is a
 * failure count, and a label that is not a counter is never folded. The `:` is optional and only
 * the label's OWN separator may sit between it and its digit — `\s*:?\s*` is the label's whitespace,
 * not a wildcard, and `Tests run:3`, `Tests run: 3` and `Ran 3` all end their label at the digit
 * while `1 == 2 tests` keeps its digits.
 */
const TALLY_TOTAL = /^(?:tests\s+run|tests|run|ran)\s*:?\s*\d$/i;

/**
 * The fold's gate, for the counted word a per-digit adjacency test cannot see.
 *
 * A failure word printed BEFORE its number (`Failures: 1`, `Errors: 2`) has no "word after the
 * digit" for {@link FAILURE_COUNT} to read, and a window wide enough to reach one hands the same
 * verdict to the comma-separated neighbour of `Tests run: 3, Failures: 1` — holding the TOTAL the
 * added-checks case exists to fold. So the test is a property of the whole line, asked once, and of
 * the narrow `Label: N` spelling only: the colon is REQUIRED because `Failures: 1` is the shape every
 * runner in this file's experience prints, and an optional colon also matches the prose `errors 2`
 * that appears in a test's own name.
 *
 * The classifier is deliberately NOT this gate. The two questions are different widths and each is
 * right where it is asked: {@link UNKNOWN_COUNTED_WORD} asks whether EVERY counted word is a known
 * counter, finds `failed` on no list, and is the right test for PERMISSION, where absence refuses.
 * For a FOLD it is the wrong test — the fold exists precisely to move the passing half of a tally
 * that reports failures, so gating the fold on "this line names a failure" refused the field case
 * from the inside and `===== 1 failed, 3 passed =====` never met `===== 1 failed, 5 passed =====`.
 */
const COUNTED_FAILURE_LABEL =
  /(?:^|[\s(,;:=])(?:failed|failing|failures?|errors?|fatal|critical)\s*:\s*[1-9]\d*(?![A-Za-z0-9])/i;

/**
 * Is THIS digit the count of a failure label — `Failures: 1`, `Errors: 2`?
 *
 * Asked per digit, which is what lets one line hold both of its halves: the Surefire tally
 * `Tests run: 3, Failures: 1` must fold its TOTAL (the added-checks case moves it) and hold its
 * `Failures:` count (a check that broke moves it), and no whole-line test can tell those two digits
 * apart. Only the digit a `Label:` immediately precedes is a failure count.
 */
function foldsAsFailureLabel(label: string, digits: string): boolean {
  return new RegExp(
    `(?:^|[\\s(,;:=])(?:failed|failing|failures?|errors?|fatal|critical)\\s*:\\s*${digits}$`,
    "i",
  ).test(label);
}

/**
 * A line's numbers read as counters, for the looser comparison pass.
 *
 * THE question this file answers, in one function: what may a runner's line move by between the
 * base run and the head run and still be the same line? The answer is exactly the words above —
 * a word on {@link COUNTER_WORDS} and a duration — and everything else stays byte-for-byte, above
 * all every count of a word that is NOT on that list. Two lines the runner means to be the same
 * failure words the shared table already reads, and the counter list for everything else — a digit
 * is folded ONLY when it is attached to a word on {@link COUNTER_WORD_LIST} (or a duration, or a
 * `Tests run: N` total), so there is no failure-word enumeration to fall behind for the words the
 * table has never heard: `999 crashed` folds to nothing because `crashed` is on no list.
 *
 * WHY a second key is needed at all, when {@link isKnownCleanLine} already allows tallies:
 * `hasHeadOnlyUnrefusedLine` vouches for a head-only line by its SHAPE, but `baselineExcuse`
 * then compares the RECOGNISED failure lines strictly, and a runner's summary of a red run
 * (`===== 1 failed, 3 passed in 0.2s =====`) is one of them — the classifier reads a counted
 * failing tally as a failure line. So the one field a PR's added checks move has to be folded on
 * BOTH sides of that comparison, or the feature refuses the case it exists to grant.
 *
 * The fold is confined to this pass. The exact key in {@link normaliseRaw} keeps every digit, and
 * that key is what is RECORDED and replayed by `ci`; a fold that reached the record would turn a
 * moved failure count into an equality the base never printed — the outcome this whole module
 * exists to refuse. Both scans are linear over a line the classifier's window already bounds and
 * no arm nests a quantifier, so no fold can backtrack.
 */
export function counterFolded(line: string): string {
  // The digit runs are located ONCE, over the line as printed, and every question below is asked
  // of that original text. Building the key as it goes and asking the questions of the key would
  // let a folded neighbour decide the next digit: `1 failed, 3 passed` reaches the `3` as
  // `1 failed, # passed`, where `failed,` sits one comma from a digit that no longer prints, and the
  // passing count the added-checks case exists to fold is held as a failure count. (This is also why
  // the scan takes a fresh iterator per line — a shared `/g` pattern resumes `lastIndex` on the
  // SECOND line and every comparison after the first read its counters as already folded.)
  const runs = [...digitRuns(line)].map((match) => ({ digits: match[0], at: match.index ?? 0 }));
  let out = "";
  let last = 0;
  for (const { digits, at } of runs) {
    const before = line.slice(Math.max(0, at - 32), at);
    const after = line.slice(at + digits.length, at + digits.length + 32);
    out += line.slice(last, at);
    // Each neighbour is asked of the ORIGINAL line, never of the key built so far: asking the key
    // read `1 failed, 3 passed` at the `3` as `1 failed, # passed`, where `failed,` sat one comma
    // from a digit that no longer printed, and held a passing count as a failure count.
    //
    // The label window is the whole prefix, not a fixed slice. `pack_release_test.sh: 36 cases, 1
    // failed` puts the word that decides the `1` a whole file name away from it, and a window short
    // enough to be a performance choice read `cases,` as that word and folded a failure count — the
    // defect that let `36 cases, 1 failed` and `36 cases, 2 failed` share a key. The line is already
    // bounded by the classifier's own scan window, so this is a bound and not a cost.
    const label = before;
    out +=
      FAILURE_COUNT.test(` ${digits}${after}`) || foldsAsFailureLabel(label, digits)
        ? digits
        : COUNTER_WORD_AFTER.test(after) ||
            COUNTER_WORD_BEFORE.test(label) ||
            DURATION_AFTER.test(after) ||
            TALLY_TOTAL.test(label.trimStart())
          ? PLACEHOLDER
          : digits;
    last = at + digits.length;
  }
  return `${out}${line.slice(last)}`.trim();
}
