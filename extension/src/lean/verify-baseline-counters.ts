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
 * THE FOLD'S FIRST BOUND, and the one no closed list of COUNTERS can draw: on a line whose own text
 * carries a failure word ANYWHERE, the only digit that may fold is one IMMEDIATELY FOLLOWED by an
 * explicit PASS word — `passed`, `skipped`, `deselected`, `xfailed`, `xpassed`, `warning(s)`. Every
 * other digit on such a line keeps its digits, whatever word sits to its left. The counter list
 * answers for the word on a digit's right, and a word on its LEFT is a LABEL whose spelling no
 * vocabulary bounds — `ran: 1 failed`, `tests: 1 failed`, `1 items failed` and `Tests run: 3, Failures:
 * 1` each put a real counter word next to the count of what broke, and each kept its digits only
 * because {@link declaresFailure} is asked of the whole line first. The counter list is still the
 * direction of the design for the lines a run prints about itself, and this bound does not make the
 * fold a failure vocabulary it has to keep current: the veto it consults is the allow-list's, and it
 * can only ever make a fold REFUSE, so a new failure word is caught by being absent and needs no
 * change here to be caught.
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
 *
 * THE IMPORT DIRECTION. `verify-baseline-allow-list.ts` imports {@link COUNTER_WORD_LIST}, {@link
 * failureLineFold} and {@link scrubInvisible} from this file, so the vocabulary and the normalisation
 * every arm applies live on the side the other imports — the allow-list may read the fold, never the
 * other way round. That is why the whole-line veto is HERE rather than there: {@link declaresFailure}
 * decides both what a head-only line may BE and which lines the fold reads as failure-reporting, and
 * a fold that consulted its own importer's veto would be a cycle. `isKnownCleanLine` keeps reading the
 * same predicate through this module, so there is still exactly one answer to "does this line name a
 * failure?".
 */

import { classifyFailureLine } from "../work-driver-verify-failures.ts";

/**
 * The line's own words, anywhere in it, say something went wrong.
 *
 * THE whole-line veto, and the one failure vocabulary this seam has — owned here so the two rules
 * that turn on it cannot drift: {@link isKnownCleanLine} refuses a head-only line whose text carries
 * one of these words, and {@link foldsAsCounter} refuses to fold a digit on such a line. A split
 * between the two would be a line that the allow-list called a failure and the fold read as a tally.
 *
 * The words are a fixed set, matched case-insensitively and WORD-BOUNDED (`fail\w*` reaches `failed`,
 * `failing`, `failures`; it does not reach `focus` or `definitely`), plus the five failure glyph
 * runners actually print (`✗ ✘ × ✕ ✖`), which have no letters to bound. The set is wide on purpose —
 * it reaches further than the classifier's anchored shapes, on purpose — and it is asked only of the
 * lines this seam is asked about, never of a stream: being wide costs a hand-back for a passing test
 * whose name happens to read like a failure (`ok 7 - login timeout retried` printed head-only) and for
 * a summary whose run total merely sits beside a `Failures:` count, while being narrow would cost a
 * green on a line that said it broke. The direction is what makes an enumeration safe here where it
 * is not safe for counters: this predicate can only ever REFUSE a permission, never grant one, so a
 * failure word the list lacks costs a hand-back and no more.
 */
const FAILURE_VETO =
  /\b(?:fail\w*|error\w*|crash\w*|abort\w*|panic\w*|timed?\s*out|timeout|segfault|broken|exception\w*|fatal|critical|killed|leak\w*)\b|[✗✘×✕✖]/i;

/**
 * Does this line's own text declare a failure, anywhere in it?
 *
 * Scrubbed for the same reason as every arm of the excuse: the veto IS the whole-line rule, and a
 * word split by an invisible character is the word — a veto that read the raw text would be the one
 * arm that still saw `fa\u200biled` as ordinary text while everything else saw `failed`.
 */
export function declaresFailure(line: string): boolean {
  return FAILURE_VETO.test(scrubInvisible(line));
}

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
 *
 * What this list CANNOT do is refuse a count on its own. `ran:` and `tests:` are on it, so a fold
 * driven only by adjacency reads the `1` of `suite ran: 1 failed` as a counter and makes it equal
 * the `2` of `suite ran: 2 failed`; `items` is on it, so `tests/x_test.py: 1 items failed` equals the
 * `2` of the same row. The refusal of those folds does not come from this list at all: it comes from
 * {@link declaresFailure}, asked of the WHOLE line before any digit is decided — on a line that names
 * a failure this list is not consulted at all, and only {@link PASS_WORD_AFTER} may fold.
 */
export const COUNTER_WORD_LIST =
  "passed|pass|passes|skipped|skips|deselected|xfailed|xpassed|warnings?|tests?|items?|cases|total";

/**
 * The PASS words a digit may fold next to: `3 passed`, `2 skipped`, `1 warning`.
 *
 * The narrowed arm, and the WHOLE of the fold on a line whose text carries a failure word anywhere.
 * A PR that adds passing tests to a suite already red at base moves exactly this kind of number — the
 * count of checks that did NOT go wrong — and the words that spell it are named exhaustively: `passed`
 * /`pass`/`passes`, `skipped`/`skips`, `deselected`, `xfailed`, `xpassed`, `warning(s)`. On such a
 * line the rule is one NEGATIVE and nothing else: a digit may fold ONLY if a pass word follows it or if
 * what follows it is no word at all — a runner's duration unit (`0.2s`, `12ms`), which counts no check
 * and keeps folding, so `===== 1 failed, 3 passed in 0.2s =====` and `===== 1 failed, 5 passed in 0.3s
 * =====` are one line. Every other digit — the one beside `items`, `tests`, `cases`, `total`,
 * `run`/`ran`, any `Label: N`, or a version — stays exactly as the runner printed it.
 *
 * Why a PASS list and not the counter list: every counter word can name the POPULATION a failed check
 * is counted in. `tests/x_test.py: 1 items failed` and the head's copy carrying `2` put `items` — a
 * legitimate counter word for a tally — beside the number that says how many checks broke, and
 * `Tests run: 3, Failures: 1` put the run's own total beside a failure report; each folded onto the
 * line a base that broke more printed, which is the one green this feature must never produce. A pass
 * word names a verdict that cannot be a broken check, so it is the only word the fold may trust once
 * the line has said something broke. Spelled out here rather than derived from {@link
 * COUNTER_WORD_LIST} so that adding a tally word there cannot widen this list by accident.
 *
 * THE ACCEPTED COST, in the safe direction and stated in `docs/lean.md` and the troubleshooting
 * entry: JUnit and Surefire print how many checks RAN as `Tests run: 3, Failures: 1`, so the run's
 * total sits on a line that names a failure and `run` is no pass word — `Tests run: 3, Failures: 1` →
 * `Tests run: 5, Failures: 1`, the usual effect of adding passing tests, now hands back. A hand-back
 * costs a human a look; the alternative was excusing a moved failure count.
 */
const PASS_WORD_AFTER =
  /^\s*(?:passed|pass|passes|skipped|skips|deselected|xfailed|xpassed|warnings?)(?![A-Za-z0-9])/i;

/**
 * The counter words a runner prints AFTER its number: `3 passed`, `2 skipped`, `5 tests`.
 *
 * These are the numbers a PR that ADDS PASSING TESTS moves, which is the field case the whole
 * tally allowance exists for. The words are {@link COUNTER_WORD_LIST} — ONE list for every reader —
 * with the leading whitespace of the fold's own slice in front of them, so the fold and the tally arm
 * cannot drift apart on what counts as a counter.
 *
 * Asked ONLY of a line {@link declaresFailure} did NOT read as failure-reporting. On a line that does,
 * this arm is too generous — `items`, `tests` and `total` are on the list, and a failed-check row puts
 * one of them beside the count of what broke — which is why {@link PASS_WORD_AFTER} exists.
 */
const COUNTER_WORD_AFTER = new RegExp(`^\\s*(?:${COUNTER_WORD_LIST})(?![A-Za-z0-9])`, "i");

/**
 * The counter words a runner prints BEFORE their number, as the LABEL of one: `Tests: 5`, `Run: 3`.
 *
 * The same closed set as {@link COUNTER_WORD_AFTER} plus the two tally-total words `run`/`ran`, and
 * only in the `Label:` spelling — a colon and nothing else between the word and its digit, and the
 * word beginning the line or after nothing but whitespace or a field separator. That is where a label
 * ends (`Tests: 5`, `Run: 3`, `Failures: 1`), and the restriction to the colon is what makes this arm
 * mean "the word of THIS number": with whitespace allowed as a separator the arm read
 * `pack_release_test.sh: 36 cases, 999 crashed` as though `cases,` — a comma, a space and a digit run
 * away — were the label of the `999`, folded a crash count that no counter list has ever named, and
 * the line met the one a base that crashed 998 times printed. `cases` still folds its own 36, because
 * there the word follows the digit and {@link COUNTER_WORD_AFTER} answers it.
 *
 * Why this arm may not scan back through a whole field: the same reasoning that makes the fold read a
 * digit's OWN word rather than one merely reachable from it. A word merely REACHABLE from a count —
 * inside a tally's earlier field, a path, or the other half of the same summary — is not that count's
 * label, and every fold driven by a reachable word has folded a failure count. So the label must end
 * in its colon at the digit, and must itself begin the line or follow nothing but whitespace or a
 * field separator.
 *
 * Asked only of a line {@link declaresFailure} did NOT read as failure-reporting — on one that does,
 * only {@link PASS_WORD_AFTER} decides, so no label of any spelling folds a digit. A `Failures: 1` /
 * `Errors: 2` label is on no list, so its count keeps its digits by the same single rule and no
 * failure-word enumeration is needed. `ok` is out of the list for the reason recorded on {@link
 * COUNTER_WORD_LIST}: a TAP runner prints its check index right after that very word.
 */
const COUNTER_WORD_BEFORE = new RegExp(
  `(?:^|[\\s(,;:])(?:${COUNTER_WORD_LIST}|(?:tests\\s+)?run|ran):\\s*$`,
  "i",
);

/** A duration unit printed after its number: `0.2s`, `12ms`, `1.5 seconds`. */
const DURATION_AFTER = /^\s*(?:ms|s|sec|secs|seconds?|minutes?|hours?)(?![A-Za-z0-9])/i;

/**
 * A tally's TOTAL — the count of how many checks ran, spelled as the label itself.
 *
 * `Tests run: 3` and `Ran 5 tests` count checks, not verdicts, so the added-checks case moves them
 * and the excuse must not read them as evidence. Asked only of a line {@link declaresFailure} did NOT
 * read as failure-reporting; the moment the line names a failure, {@link PASS_WORD_AFTER} is the only
 * arm left, and the accepted cost of that is the `Tests run: 3, Failures: 1` total. The label arm of
 * {@link foldsAsCounter} carries `run`/`ran`, and this arm carries the spelling where the total has no
 * word of its own after the digit — `Tests run: 3` ends its label at the digit, and the `3` is the
 * whole of what follows the label, so the pair is read as one token here rather than by an adjacency
 * test on the text after the number. `Failures`/`Errors` are not in this list at all: a label that is
 * not a counter is never folded, and the `:` is only ever the label's own whitespace, never a
 * wildcard, so `1 == 2 tests` keeps its digits.
 */
const TALLY_TOTAL = /^(?:tests\s+run|tests|run|ran)\s*:?\s*\d$/i;

/**
 * Is THIS digit a runner's counter, a duration, or a count of checks that passed?
 *
 * THE single rule of the fold, in two halves decided by ONE question asked of the whole line first:
 * does its text name a failure ({@link declaresFailure})?
 *
 *   - A line that names NONE is a runner counting its own run, and its digits fold next to any word on
 *     {@link COUNTER_WORD_LIST} — printed after it (`3 passed`, `2 skipped`, `36 cases`) or before it
 *     as its `Label:` (`Tests: 5`, `Run: 3`) — or next to a duration unit (`0.2s`), or as the `Tests
 *     run: N` total. The counter list is closed on the counter side, so a word it has never heard
 *     keeps its count exact by absence: `999 crashed` keeps its digits because `crashed` is on no list.
 *   - A line that names ONE — anywhere, in any dialect — may move only the count of a PASS word
 *     ({@link PASS_WORD_AFTER}). `===== 1 failed, 3 passed =====` still folds its `3` and holds its
 *     `1`; `1 items failed`, `tests: 1 failed`, `suite ran: 1 failed` and `Tests run: 3, Failures: 1`
 *     hold every digit they carry, because each puts a legitimate tally word beside the number that
 *     says what broke, and a tally word counts a POPULATION, not a verdict.
 *
 * The failure half is deliberately not a per-digit vocabulary: the digits of a line are decided by
 * whether the LINE names a failure at all, by the same wide whole-line veto the allow-list applies,
 * never by which word happens to sit next to a given digit. That is what lets `1 items failed` refuse
 * while `36 cases` folds — the first is on a line that said something broke, the second is not — and
 * it is why no enumeration here can go stale the way the per-digit {@code FAILURE_COUNT} arms did.
 * `TALLY_TOTAL` and the exemption pair that used to sit beside it (`FAILURE_WORD_AFTER` /
 * `RUN_TOTAL_REPORTED` / `LABEL_FIELD`) tried to draw that line one digit at a time; each needed a
 * shape saying which failure word counted, and each was one dialect away from excusing a moved failure
 * count.
 *
 * "Adjacent" is the load-bearing word in both halves: each arm reads only its own side and only the
 * label's own separator, so a counter word merely REACHABLE from a digit — two commas away, inside
 * another field of the same tally, in a path — does not decide that digit.
 */
function foldsAsCounter(label: string, after: string, reportsFailure: boolean): boolean {
  // On a failure-reporting line, a digit folds only if a PASS word follows it, or if what follows it is
  // no word at all — a duration unit (`0.2s`), which counts no check. A digit followed by any WORD the
  // pass list does not name is held exact however legitimate that word is as a tally's counter. See
  // {@link PASS_WORD_AFTER} for why the excluded set is every counter word rather than a list of
  // failure words.
  if (
    reportsFailure &&
    !DURATION_AFTER.test(after) &&
    !PASS_WORD_AFTER.test(after) &&
    after.trimStart().length > 0
  ) {
    return false;
  }
  return (
    COUNTER_WORD_AFTER.test(after) ||
    COUNTER_WORD_BEFORE.test(label) ||
    DURATION_AFTER.test(after) ||
    TALLY_TOTAL.test(label.trimStart())
  );
}

/**
 * A line's numbers read as counters, for the looser comparison pass.
 *
 * THE question this file answers, in one function: what may a runner's line move by between the base
 * run and the head run and still be the same line? A line that names no failure folds next to any word
 * on {@link COUNTER_WORD_LIST} (or a duration, or a `Tests run: N` total), so there is no failure-word
 * enumeration to fall behind for the words the table has never heard: `999 crashed` keeps its digits
 * because `crashed` is on no list. A line that names a failure anywhere folds only next to a PASS word
 * ({@link PASS_WORD_AFTER}), so the whole of what may move there is the count of checks that passed.
 *
 * The failure-reporting flag is asked ONCE for the line, before any digit is decided, and by
 * {@link declaresFailure} on the whole line rather than per digit — see {@link foldsAsCounter} for why
 * that is the only shape of the rule that holds.
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
  // Asked of the WHOLE line, once, before the first digit is decided — the veto is a property of the
  // line, not of any one number on it. Asking it per digit is the shape that let `1 items failed` and
  // `2 items failed` share a key: the word beside each digit is a legitimate counter word, so only the
  // line's own text can say that this row is about failed checks.
  const reportsFailure = declaresFailure(line);
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
    out += foldsAsCounter(label, after, reportsFailure) ? PLACEHOLDER : digits;
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
 * `collected 14 items`, `pack_release_test.sh: 36 cases, 0 failed`). Those move legitimately when the
 * PR adds checks, and every failure count they carry still keeps its digits by {@link
 * foldsAsCounter}, which the gate above does not replace but sits in front of. A line the classifier
 * did not read is NOT thereby a clean line: `tests/x_test.py: 1 items failed` is neither, and on it
 * the veto inside {@link foldsAsCounter} holds every digit — including the run's own `Tests run:` total
 * beside a `Failures:` count, which is the accepted cost the docs name.
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
