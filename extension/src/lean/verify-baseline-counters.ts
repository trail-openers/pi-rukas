/**
 * lean/verify-baseline-counters — what a runner's line may MOVE by between two runs.
 *
 * The comparison half of the baseline excuse, split out from `verify-baseline-allow-list.ts`:
 * that file answers WHAT MAY BE EXCUSED (which head-only line is provably not a failure), this one
 * answers WHAT MAY MOVE (which fields of a line the two runs mean to be the same). The two are one
 * question seen from two sides — a runner's counters are exactly the fields a PR that adds passing
 * tests moves — so they share {@link COUNTER_WORD_LIST}, the closed set both read, and are read
 * together by {@link isKnownCleanLine} and {@link failureLineFold}.
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
 *
 * THE FOLD'S OTHER BOUND, and the one the counter list cannot draw: the fold is asked of the lines
 * the shared classifier ACCEPTED as failure lines as well as of the tallies it did not, and a
 * per-check failure line is compared strictly. `FAILED a.py::t - AssertionError: got 5 items` and
 * `… got 50 items` differ by the number the assertion is ABOUT, and `items` — a legitimate counter
 * word for a tally — sits right next to it, so a fold driven only by the word list read the two as
 * one line and excused the failure this run authored. Which line is a per-check report is the
 * classifier's answer, not a word list's, so {@link foldsAsCounter} is reached only for a line the
 * classifier did NOT read as a failure: a summary, a tally, a collection count. {@link
 * failureLineFold} applies that gate and is the only fold the comparison consults.
 */

import { classifyFailureLine } from "../work-driver-verify-failures.ts";

/**
 * The placeholder a folded field is replaced with.
 *
 * A character no runner prints (`#` is neither a digit nor a status word), so a real line can
 * never collide with a folded one and two lines that differ by content never collapse onto it.
 */
const PLACEHOLDER = "#";

/**
 * The invisible characters a runner's output can carry inside a WORD.
 *
 * grave, a byte-order mark. None of them renders, all of them break a word in two: a word with a
 * zero-width space inside it is not that word to a `\b`-bounded vocabulary, to the classifier's
 * anchored shapes, or to a strict line comparison, and a human reading the log sees the word.
 * `\u00ad` (soft hyphen), `\u200b-\u200d` (zero-width space, joiner, non-joiner), `\u2060` (word
 * joiner), `\u034f` (combining grave) and `\ufeff` (BOM) — written as escapes, which is the only way
 * to name them without putting the characters themselves in the source. The class is a fixed set of
 * format characters, not a general Unicode sweep: it is NOT `\p{Cf}` and not a control-character class,
 * because a line's printable content is evidence and is left exactly as printed. Each range is written
 * on its own rather than merged into one class, so a reader — and Biome's misleading-character-class
 * rule — can see each character this arm removes.
 */
const INVISIBLE_CHARS = new RegExp(
  `[${["\\u00ad", "\\u200b-\\u200d", "\\u2060", "\\u034f", "\\ufeff"].join("")}]`,
  "g",
);

/**
 * An ANSI CSI sequence: an escape, a parameter string, and a final byte.
 *
 * A colour or cursor sequence sits inside a line the same way an invisible character does — a colour
 * code between the halves of a verdict prints as that verdict — and is stripped by {@link
 * scrubInvisible} for the same reason.
 *
 * Built from `String.fromCharCode(27)` rather than a `\u001b` escape in the literal: Biome's
 * `noControlCharactersInRegex` is right that a control character written into a pattern is easy to
 * misread, and here it is genuinely easy to misread — the ESC byte is the whole meaning of the arm and
 * nothing around it shows it. `fromCharCode` is the house form for this byte (`merge-lex-views.ts`,
 * `write-fence-bash-words.ts` both name ESC the same way). The parameter bytes are `[\d;?]*`, which
 * never include the final byte, and the final byte is one character: no quantifier may stretch across
 * a line, so no input makes this backtrack.
 */
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[\d;?]*[A-Za-z@]`, "g");

/**
 * The Unicode line separators, mapped to a space rather than removed.
 *
 * U+2028, U+2029 and C1 U+0085 are line boundaries to some tools and ordinary characters to others,
 * so one stream can carry two lines that this gate reads as one. Replacing them with a space keeps the
 * words either side of them separate — removing them would glue a crash count to the tally beside it —
 * and leaves the line as ONE line for every arm. Written with `\p{Cc}` plus the two Unicode separators
 * rather than literal control characters: the set is "every character some renderer breaks a line on",
 * which is the property the arm needs, and a control character has no place in a source pattern.
 */
const LINE_SEPARATORS = /[\p{Cc}\u2028\u2029]/gu;

/**
 * A line as EVERY arm of the baseline excuse must read it: invisible characters out, ANSI sequences out, line separators flattened.
 *
 * THE one normalisation of the whole comparison, applied where the excuse reads lines — {@link
 * streamLines} in `verify-baseline-allow-list.ts`, and the head of {@link failureLineFold} here — so no
 * arm can judge a text another arm did not. It runs BEFORE classification and before any veto, which
 * is the only ordering that makes the promise true: a failure word split by an invisible character IS
 * that word, and an arm that normalised after its own match would be vouching for text the next arm
 * never saw. Printable content is untouched, so nothing a runner actually printed is erased.
 *
 * Control characters go to a space, not nothing: a C1 in the middle of a stream is a boundary a reader
 * would honour, and deleting it would splice two fields into one word.
 *
 * Lives in this leaf module because both sides of the excuse seam need it and the seam must stay one
 * way: `verify-baseline-allow-list.ts` imports the counter vocabulary from here, so the normalisation
 * every arm applies cannot be moved to the importer without cutting the other direction.
 */
export function scrubInvisible(line: string): string {
  return line.replace(ANSI_CSI, "").replace(INVISIBLE_CHARS, "").replace(LINE_SEPARATORS, " ");
}

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

/**
 * The counter words a runner prints BEFORE their number, as the LABEL of one: `Tests: 5`, `Run: 3`.
 *
 * The same closed set as {@link COUNTER_WORD_AFTER} plus the two tally-total words `run`/`ran`, and
 * only in the `Label:` spelling — a colon and nothing else between the word and its digit. That is
 * where a label ends (`Tests: 5`, `Run: 3`, `Failures: 1`), and the restriction to the colon is what
 * makes this arm mean "the word of THIS number": with whitespace allowed as a separator the arm read
 * `pack_release_test.sh: 36 cases, 999 crashed` as though `cases,` — a comma, a space and a digit run
 * away — were the label of the `999`, folded a crash count that no counter list has ever named, and
 * the line met the one a base that crashed 998 times printed. `cases` still folds its own 36, because
 * there the word follows the digit and {@link COUNTER_WORD_AFTER} answers it.
 *
 * A `Failures: 1` / `Errors: 2` label is on no list, so its count keeps its digits by the same single
 * rule and no failure-word enumeration is needed anywhere in this file. `ok` is out of the list for
 * the reason recorded on {@link COUNTER_WORD_LIST}: a TAP runner prints its check index right after
 * that very word.
 */
const COUNTER_WORD_BEFORE = new RegExp(
  `(?:^|[\\s(,;:=])(?:${COUNTER_WORD_LIST}|(?:tests\\s+)?run|ran):\\s*$`,
  "i",
);

/** A duration unit printed after its number: `0.2s`, `12ms`, `1.5 seconds`. */
const DURATION_AFTER = /^\s*(?:ms|s|sec|secs|seconds?|minutes?|hours?)(?![A-Za-z0-9])/i;

/**
 * Is THIS digit a runner's counter or duration?
 *
 * THE single rule of the fold, and the whole of it: a digit run is folded when the word ADJACENT to
 * it is on {@link COUNTER_WORD_LIST} — printed after it (`3 passed`, `2 skipped`, `36 cases`) or
 * before it as its `Label:` (`Tests: 5`, `Run: 3`) — or when what sits next to it is a duration unit
 * (`0.2s`) or the `Tests run: N` total. Anything else keeps the digits exact. "Adjacent" is the load-
 * bearing word: each arm reads only its own side and only the label's own separator, so a counter word
 * that is merely REACHABLE from a digit — two commas away, inside another field of the same tally —
 * does not decide that digit.
 *
 * The rule is single, so there is no failure-word list anywhere in this file: `failed`, `crashed`,
 * `panicked`, `aborted` and `segfault` are all absent from the counter list and all keep their counts
 * exact by absence, which is the direction that cannot fall behind a runner's vocabulary.
 *
 * This replaces three arms that existed only because the rule was not yet single. `FAILURE_COUNT` /
 * `COUNTED_FAILURE_LABEL` / `foldsAsFailureLabel` enumerated failure words to hold them exact — right
 * for the words they listed, wrong for the words they did not, and `999 crashed` was such a word: it
 * reached the fold through the `cases` of its own tally and matched the line a base that crashed 998
 * times printed. `TALLY_TOTAL` folded the `Tests run: N` total, which the label arms of this rule
 * already cover. Both were a failure vocabulary in a file whose design says a failure vocabulary is
 * unbounded, and one adjacency test that reads only its own side replaces all four.
 */
function foldsAsCounter(label: string, after: string): boolean {
  return (
    COUNTER_WORD_AFTER.test(after) ||
    COUNTER_WORD_BEFORE.test(label) ||
    DURATION_AFTER.test(after) ||
    TALLY_TOTAL.test(label.trimStart())
  );
}

/**
 * A tally's TOTAL — the count of how many checks ran, spelled as the label itself.
 *
 * `Tests run: 3` and `Ran 5 tests` count checks, not verdicts, so the added-checks case moves them
 * and the excuse must not read them as evidence. The label arm of {@link foldsAsCounter} carries
 * `run`/`ran`, and this arm carries the spelling where the total has no word of its own after the
 * digit — `Tests run: 3` ends its label at the digit, and the `3` is the whole of what follows the
 * label, so the pair is read as one token here rather than by an adjacency test on the text after
 * the number. `Failures`/`Errors` are not in this list at all: a label that is not a counter is
 * never folded, and the `:` is only ever the label's own whitespace, never a wildcard, so
 * `1 == 2 tests` keeps its digits.
 */
const TALLY_TOTAL = /^(?:tests\s+run|tests|run|ran)\s*:?\s*\d$/i;

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
 * then compares the RECOGNISED failure lines too, and a runner's summary of a red run
 * (`===== 1 failed, 3 passed in 0.2s =====`) is a line the added-passing-tests case moves. So the
 * one field a PR's added checks move has to be folded on BOTH sides of that comparison, or the
 * feature refuses the case it exists to grant.
 *
 * PRIVATE on purpose: every caller of this file is {@link failureLineFold}, which is where the one
 * rule this fold must obey — never on a line the classifier read as a failure — is applied.
 *
 * The fold is confined to this pass. The exact key in {@link normaliseRaw} keeps every digit, and
 * that key is what is RECORDED and replayed by `ci`; a fold that reached the record would turn a
 * moved failure count into an equality the base never printed — the outcome this whole module
 * exists to refuse. Both scans are linear over a line the classifier's window already bounds and
 * no arm nests a quantifier, so no fold can backtrack.
 */
function counterFolded(input: string): string {
  // Scrubbed before the digit scan, for the one reason every arm of the excuse scrubs: a zero-width
  // character inside a counted word would otherwise leave the adjacency test reading a crash word split
  // in half — no counter word next to the digits, so they stand — while every other arm saw a clean
  // count. Idempotent, and the classifier's window already bounds the line, so this is a bound and not
  // a cost. The scrubbed text is held in its own binding because every question below is asked of the
  // line as printed, and a fold that read a key it had built itself is how a moved count went unnoticed.
  const line = scrubInvisible(input);
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
    out += foldsAsCounter(label, after) ? PLACEHOLDER : digits;
    last = at + digits.length;
  }
  return `${out}${line.slice(last)}`.trim();
}

/**
 * A line's counter numbers folded, UNLESS the classifier read the line as a failure line.
 *
 * THE fold every comparison pass consults, and the gate on it. A line the classifier ACCEPTED is
 * a report about one check — `pytest-failed`, `tap-not-ok`, `go-fail`, the `named-file` dialect, an
 * assertion mark — and it is compared byte-for-byte: `FAILED a.py::t - AssertionError: got 5 items`
 * and `… got 50 items` are two findings, and `not ok 1 - checkout - expected 3 items found 0` and
 * `… expected 6 items …` are two checks. Both pairs used to share a key here, because `items` is a
 * legitimate counter word for a tally and sat next to the very digit that differed: the word list
 * answers WHAT MAY MOVE inside a line that counts its own run, and it cannot answer whether the
 * line is one check's verdict at all. Only the classifier can, so its answer is the gate.
 *
 * The fold therefore reaches only lines the classifier did NOT read as a failure — the tallies and
 * summaries that ARE the added-passing-tests case (`===== 1 failed, 3 passed in 0.2s =====`,
 * `Tests run: 5, Failures: 1`, `collected 14 items`). Those move legitimately when the PR adds
 * checks, and every failure count they carry still keeps its digits by {@link foldsAsCounter},
 * which the gate above does not replace but sits in front of.
 *
 * The one line whose fold still matters after this gate is the counted summary of a red run: the
 * classifier's own `named-file` arm reads `a.py: 36 cases, 1 failed, 3 passed` as a failure line,
 * so that line now compares strictly, and `hasHeadOnlyUnrefusedLine` vouches for its head-only
 * copy by shape alone only when every count it carries names a counter. Nothing in either pass
 * folds a number inside a line that names a broken check.
 */
export function failureLineFold(input: string): string {
  // Asked of the line as printed: `classifyFailureLine` trims and applies its own scan window, and
  // the two sides of the comparison hand it lines already scrubbed by {@link scrubInvisible}, which
  // is the same text every other arm of the excuse judges.
  if (classifyFailureLine(input) !== undefined) return input.trim();
  return counterFolded(input);
}
