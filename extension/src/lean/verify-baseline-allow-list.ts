/**
 * lean/verify-baseline-allow-list — what a head-only line may BE and still be excused.
 *
 * The baseline excuse (`verify-baseline-excuse.ts`) compares the head run's failure lines
 * against the base run's, and its whole safety rests on one question, which is the question
 * this module owns: a line the HEAD printed and the base did not — what could it possibly be
 * that makes it safe to ignore? The answer must be a permission, never a pardon. A line is
 * excused only if something POSITIVE here proves it cannot be declaring a failure; anything
 * this file has never heard of REFUSES.
 *
 * That direction is the entire design. `failureLines` drops every line the shared classifier
 * does not recognise, so an omitted line would let a head of `[readable A, unread B]` match a
 * base that printed only A and grade a tier GREEN on a failure this run authored — the one
 * outcome the feature must never produce. A list of what-IS-a-failure tokens cannot be closed:
 * runners are unbounded, so such a list rots. The question is therefore asked the other way
 * round: the list here holds what is NOT a failure — pass markers, progress lines, separators,
 * counts — and it is short precisely because that set is small and stable. A new runner's
 * failure dialect is caught by being absent from it, needing no change here to be caught and
 * only a change here to be excused.
 *
 * Two exclusions are applied to both streams before any comparison, and both are about WHO
 * WROTE the line rather than what it says: the harness's own writing (the executor's kill and
 * echo lines, which never came from the gate) and any line the classifier positively reads as a
 * PASSING check (a PR that adds passing tests prints new ones of those every run). Neither is an
 * exemption from the rule — a line that survives both filters and matches nothing is refused on
 * its face, whatever it opens with.
 *
 * EVERY arm here vouches for the WHOLE LINE. An arm that reads only as far as its own shape
 * reached lets through a line that goes on to say the opposite (`ok, the brand new deploy check
 * failed`, a result row carrying an `F`, `===== 999 crashed, 9 passed =====`). Two rules make
 * the whole-line promise mechanical: {@link declaresFailure} vetoes any line whose text carries
 * a failure word or a failure glyph ANYWHERE in it, and {@link COUNTER_WORDS} admits a counted
 * word only by being on an explicit list of things a runner counts that did not go wrong —
 * absence refuses. The cost of the first is accepted and documented: a PASSING test whose NAME
 * contains such a word, when the line is head-only, is refused, and a refusal is a hand-back,
 * never a green.
 *
 * The comparison keys live here too ({@link normaliseRaw}, {@link failureLineFold}) because WHAT
 * MAY MOVE is the same question as WHAT MAY BE EXCUSED, and it is answered in one place: only a
 * runner's counters, never a failure count, and never anything at all inside a line the
 * classifier read as one check's failure. A runner's check index is not folded — nothing ties it
 * to the check, so a renumbered failure is refused (see {@link failureLineFold} for the one field
 * the comparison still folds).
 *
 * And every arm reads the SAME text, because {@link scrubInvisible} runs once where the lines
 * are read: a word split by a zero-width space (`fa\u200biled`) is invisible to the eye, to
 * {@link declaresFailure}'s word-bounded vocabulary, and to the classifier's anchored shapes,
 * so a rule that normalised in only one arm would be a rule the other arms did not apply.
 */

import { classifyFailureLine, isSuccessLine } from "../work-driver-verify-failures.ts";
import { COUNTER_WORD_LIST, failureLineFold } from "./verify-baseline-counters.ts";
import { stripRoot } from "./verify-baseline-excuse.ts";
import { harnessWordsRemoved, isHarnessEchoOf, isHarnessLine } from "./verify-baseline-harness.ts";
import { scrubInvisible } from "./verify-baseline-scrub.ts";
import { declaresFailure } from "./verify-baseline-veto.ts";

/**
 * A line that reports a check as PASSING, in the dialects the allow-list has to read.
 *
 * Every arm is ANCHORED, every arm admits a passing verdict, and no arm vouches past the
 * character it matched — {@link declaresFailure} reads the REST of the line:
 *
 *   - `ok`, `PASS`, `PASSED`, `✓` as the WORD a line OPENS with (`PASS tests/x.py::t`,
 *     `ok 3 - t/x.t`). The negative lookahead is what keeps `passage`, `okay` and `passive`
 *     from reading as pass markers, and a line opening `FAIL` or `not ok` cannot match. What
 *     follows the marker is the runner's own report of the check, and `ok 4 - brand new check
 *     FAILED` is a failure wearing a pass marker — which is why the marker is necessary and
 *     never sufficient, and why the veto rather than this arm answers that one;
 *   - a tally that counts only things that did not go wrong (`3 passed`, `12 passed, 0 failed`),
 *     where the count opens the line and every counted word is on {@link COUNTER_WORDS}; and
 *   - go test's per-check lines: `=== RUN   TestX` (a run banner, which carries no verdict)
 *     and `--- PASS: TestX`.
 *
 * This list is never asked alone: {@link isKnownCleanLine} consults the shared classifier
 * first, so a line the table reads as a failure is not admitted here however it is shaped. That
 * ordering is what lets these arms be short anchored words instead of a complete vocabulary of
 * everything runners print — the vocabulary is the classifier's, and duplicating it here is the
 * mistake this module exists to avoid. The veto is deliberately WIDER than the table (see
 * {@link declaresFailure}): being wide here costs a hand-back, being wide there costs a green.
 */
const PASS_MARKER =
  /^(?:ok(?![A-Za-z0-9])|PASS(?:ED)?(?![A-Za-z0-9])|✓)[\s:]*|^\d[\d.,\s]*(?:passed|ok)\b/i;

/** go test -v's run banner and its passing verdict for one check. */
const GO_RUN_LINE = /^\s*(?:={3,}\s*RUN\b|-{3,}\s*PASS:)/i;

/**
 * A runner's progress line: dots, names, and the percentage the runner computed.
 *
 * pytest's DEFAULT output is this (`tests/x.py ..  [ 50%]`) and it is the only line such a
 * run prints per passing check, so a PR that adds a passing check moves it. The class
 * admits only what a progress line is made of (path characters, dots, names, the bracketed
 * percentage) and the form REQUIRES a bracketed percentage, which a failure line does not
 * carry — `brand new check ... FAILED` has no `[N%]` to end on.
 *
 * WHAT THE RESULT RUN IS MADE OF is the second half of the arm: `F` is a failed check and `E`
 * an error, and pytest prints them in the SAME run of characters it prints `.` in, so a class
 * that read only the shape vouched for `tests/x.py ....F... [ 50%]`. A result glyph is therefore
 * admitted by name — `.`, `s` (skipped) and `x` (expected-fail) are checks that did not go wrong
 * — and every other character in the row's result run is what {@link PROGRESS_BAD_GLYPH}
 * refuses.
 *
 * The veto reads the run, never the line: `tests/deploy_timeouts.py ..  [100%]` carries `F` and
 * `T` in its NAME and excuses, because a file name is not a verdict. The runner's own whitespace
 * is the seam — path, result run, percentage — so a name can never veto its own row.
 */
const PROGRESS_LINE = /^[\s./\\A-Za-z0-9_[\]%<>:-]*[.sx][\s.]*\[\s*\d+[\d.,]*%?\s*\]\s*$/;

/** A character that is not a passing result glyph. `F` failed, `E` errored, `T` is pytest's timeout. */
const PROGRESS_BAD_GLYPH = /[^.sx]/;

/**
 * Is this progress row's result run made only of passing glyphs?
 *
 * The row is split on the runner's own whitespace and the fields a result run NEVER lives in are
 * dropped: the bracketed percentage, the separator padding (`=====`), and anything carrying a path
 * separator — that is the file the row reports on, whose name is not a verdict
 * (`tests/deploy_timeouts.py` has an `F` and a `T` in it). What is left, and starts with a result
 * glyph, IS the result run, and one character in it outside `.sx` is a failed check. A row with no
 * such field reports no result and comes back not-clean: an arm that excused a row for showing
 * nothing would excuse a row for showing nothing.
 */
function progressRowIsClean(line: string): boolean {
  let sawResultRun = false;
  for (const token of line.split(/\s+/)) {
    if (token.length === 0) continue;
    if (token.includes("[") || token.includes("]")) continue;
    if (token.includes("/") || token.includes("\\")) continue;
    if (!/^[.sx]/.test(token)) continue;
    sawResultRun = true;
    if (PROGRESS_BAD_GLYPH.test(token)) return false;
  }
  return sawResultRun;
}

/** A runner's section rule or banner: a run of ONE punctuation character only. */
const SEPARATOR_LINE = /^([=\-_#*])\1{2,}$/;

/**
 * A runner's summary of the WHOLE run: its counts, and the padding around them.
 *
 * pytest prints `===== 5 passed in 0.2s =====` and the same tally bare (`3 passed in 0.4s`);
 * jest prints `Tests: 5 passed, 5 total`. The shape is `\d+ word` pairs separated by commas,
 * with runner padding either side — so no line carrying a path, a check name, or an assertion
 * can match it.
 *
 * A tally on the allow-list is not a claim that the run PASSED — it is a claim that THE LINE IS
 * A TALLY rather than a verdict about one check. Its safety comes from the two rules around it,
 * both stronger than it is: the classifier is asked FIRST ({@link isKnownCleanLine}) and reads a
 * counted failing tally (`1 failed`, `2 errors`) and a `FAILURES!` banner as failure lines, and
 * the tier is excused only when its recognised failure lines ALL match the base's (the set
 * comparison in `verify-baseline-excuse.ts`).
 *
 * The case a naive list gets wrong, and why this arm exists: a suite ALREADY RED at base, to
 * which this PR ADDS PASSING tests. Its summary counts differently from the base's (`5 passed`
 * where the base printed `3 passed`), and an excuse that read a moved count as a new failure
 * line would refuse the one case it exists to grant. A count is not evidence about which checks
 * failed.
 *
 * The third rule makes that true rather than hopeful: every `<number> <word>` pair the shape
 * matched must count something on {@link COUNTER_WORDS}. The shape answers "is this a tally?"
 * and nothing else, so on its own it admitted `===== 999 crashed, 9 passed =====`. A counted word
 * is admitted by being KNOWN and refused by being absent — the direction the whole file runs in.
 */
const RUN_SUMMARY =
  /^[\s=*_~.,:-]*(?:[A-Za-z][\w. -]{0,24}:\s*)?(?:\d[\d.]*\s+\w+[\w.,-]*\s*,?\s*){1,6}(?:in\s+[\d.]+\s*(?:ms|s|sec|secs|minutes?)?\s*)?[\s=*_~.,-]*$/i;

/** Runner padding, which the tally arms read as decoration and must not read as content. */
const PADDING = /^[\s=*_~.,:-]+|[\s=*_~.,:-]+$/g;

/**
 * The words a runner counts that did NOT go wrong live in `verify-baseline-counters.ts`, where
 * the reasoning for the closed set lives, and are read HERE too so the two rules that judge a
 * runner's numbers cannot drift apart.
 *
 * {@link COUNTER_WORD_LIST} as a whole word, which is how every reader of it must match it.
 */
const COUNTER_WORDS = new RegExp(`^(?:${COUNTER_WORD_LIST})(?![A-Za-z0-9])$`, "i");

/**
 * A `<number> <word>` pair whose word is NOT a known counter — `999 crashed`, `3 panicked`.
 *
 * The veto the tally arm and {@link isPassingLine} share, so that ONE question — "does this line
 * count something that is not a counter?" — has ONE answer wherever it is asked. Applied to the
 * trimmed line with {@link PADDING} stripped for the tally arm (the `=====` a pytest summary
 * wears is decoration, not a counted word), and to the bare trimmed line for the passing arm.
 *
 * The word is read AFTER the number, which is how every runner this file reads spells a tally.
 * The reverse spelling (`Failures: 1`) is not caught here — its word sits BEFORE its number — and
 * that is a deliberate boundary, not a gap: the shared classifier already reads that dialect as a
 * failure line, so both {@link isKnownCleanLine} and {@link isPassingLine} refuse it on the
 * classifier's answer and {@link failureLineFold} leaves its digits standing.
 */
const UNKNOWN_COUNTED_WORD = new RegExp(
  // `[1-9]`, not `\d`: a count of ZERO is the clean case, not a report. `===== 0 failed, 3 passed
  // in 0.2s =====` names nothing that broke, and the shared classifier agrees -- its own
  // `hasCountedTally` requires a non-zero count before it reads a tally as a failure line. A
  // veto that read `0 failed` as a counted non-counter would refuse the cleanest summary a
  // runner prints, and the excuse would hand back a run whose suite is only red elsewhere.
  `(?:^|[\\s(,;:])\\s*[1-9]\\d*\\s+(?!(?:${COUNTER_WORD_LIST})(?![A-Za-z0-9]))(?:[A-Za-z][\\w-]*)`,
  "i",
);

/**
 * A TAP plan line: `1..9`, `1..10` — how many checks the runner INTENDS to print.
 *
 * A plan is a counter, not a verdict: `not ok` (a failed check) is a different line and the
 * classifier reads that one. A PR that ADDS a passing check moves the plan, so without this
 * arm the added-tests case refuses on its own header.
 */
const TAP_PLAN = /^\s*\d+\.\.\d+\s*$/;

/** How many tests a collecting runner found — a count, not a verdict. */
const COLLECTION_LINE = /^collected\s+\d+\s+(?:item|test)s?\b/i;

/**
 * Is a head-only line one the excuse may ignore, because it cannot declare a failure?
 *
 * The DIRECTION is the point: a shape this list has never heard of REFUSES, which costs a
 * hand-back, and is never read as clean, which would cost a green. The list may be imperfect only
 * in the safe direction, and a new runner's failure dialect needs no change here to be CAUGHT —
 * only to be excused.
 *
 * Two rules apply to EVERY arm rather than to one of them, and together they are what "vouches
 * for the whole line" means in code:
 *
 *   - the classifier is asked FIRST, so a line the table reads as a failure is never clean,
 *     whatever else it looks like (`✗ x` opens like a pass glyph, a `FAILURES!` banner is built
 *     from separator characters); and
 *   - {@link declaresFailure} vetoes a line whose text carries a failure word or glyph ANYWHERE,
 *     so no arm ends its reading at its own match. The classifier's shapes are anchored and
 *     cannot see `ok 4 - brand new check FAILED`; the veto reads the whole line and does.
 *
 * THE COST, accepted: a PASSING test whose NAME contains a failure word, when the line is
 * head-only, is vetoed and therefore refused, and the tier hands back instead of excusing. A
 * hand-back costs a human a look; the alternative is a green on a line that named a failure.
 */
export function isKnownCleanLine(line: string): boolean {
  // The whole-line judgement is asked of the SCRUBBED text: this arm is reached both through
  // {@link judgeableLines} (already scrubbed by {@link streamLines}) and directly, by a caller holding
  // a raw line, and an arm that judged one text here and another there would be a rule the other arm
  // never applied. Scrubbing twice is the same answer, so this arm does not ask where it came from.
  const t = scrubInvisible(line).trim();
  if (classifyFailureLine(t) !== undefined) return false;
  if (declaresFailure(t)) return false;
  const tally = t.replace(PADDING, "");
  return (
    PASS_MARKER.test(t) ||
    GO_RUN_LINE.test(t) ||
    (PROGRESS_LINE.test(t) && progressRowIsClean(t)) ||
    SEPARATOR_LINE.test(t) ||
    (RUN_SUMMARY.test(tally) && !UNKNOWN_COUNTED_WORD.test(tally)) ||
    TAP_PLAN.test(t) ||
    COLLECTION_LINE.test(t)
  );
}

/**
 * Every raw line of a stream, scrubbed of invisible characters, trimmed, blanks dropped.
 *
 * Exported because the two rules that read a whole stream live on either side of the module seam
 * and must ask the SAME question of it — anything else is two definitions of "a line", and with
 * {@link scrubInvisible} in the seam, two definitions of "the text of a line". Every single-line
 * arm in this file scrubs its own argument too, so a caller holding a raw line gets the same
 * answer as a line that came through a stream.
 */
export function streamLines(stream: string): string[] {
  return stream
    .split(/\r\n|\r|\n/)
    .map((line) => scrubInvisible(line).trim())
    .filter((line) => line.length > 0);
}

/**
 * Does the shared classifier read this line as a check that PASSED?
 *
 * `classifyFailureLine` answers `undefined` for BOTH a passing line and a line it does not know,
 * and the two must not be treated alike: an unread line is a failure nobody read and gets no
 * exemption (the whole of the default-refuse rule), while a line the classifier positively reads
 * as success is a runner reporting a passing check — and a PR that adds passing tests prints new
 * ones on every run.
 *
 * The whole-line veto is asked HERE too, because this is the OTHER door a head-only line walks out
 * through: a line excluded as "passing" never reaches {@link isKnownCleanLine} at all, and the
 * classifier's `\d+\s+passed` arm is an unanchored substring search that fires on the `4` and the
 * `FAILED` of `ok 4 - brand new check FAILED`. No exemption survives the line's own words saying
 * something broke.
 *
 * ONE class of line is exempt from the veto at this door, and it is why the veto is not simply
 * asked first: a runner's COUNTED SUMMARY of a red run (`===== 1 failed, 5 passed in 0.42s =====`)
 * legitimately names failures, is read as success by that same arm, and is the line the
 * added-passing-tests case MOVES. So a tally is judged by {@link UNKNOWN_COUNTED_WORD} instead of
 * by the word list: every count it carries must name a word on {@link COUNTER_WORD_LIST}, or the
 * exemption goes. A clean pass line leaves both streams and cannot make a head-only line, so
 * exempting it costs nothing; a counted summary of a red run stays in the stream, where
 * {@link failureLineFold} folds the one field a PR's added checks move.
 */
function isPassingLine(line: string): boolean {
  const t = scrubInvisible(line);
  const tally = t.trim().replace(PADDING, "");
  // The tally arm keeps its OWN gate rather than the word veto, and the ordering is load-bearing:
  // the veto in front of this arm would refuse the one case the excuse exists to grant (see the
  // jsdoc). A TAP verdict wearing a pass count (`not ok 5 - brand new check 9 passed`) has a
  // tally's shape and a `not ok` its own, which the counter gate catches.
  if (RUN_SUMMARY.test(tally))
    return !UNKNOWN_COUNTED_WORD.test(tally) && !declaresFailure(harnessWordsRemoved(tally));
  if (declaresFailure(harnessWordsRemoved(t))) return false;
  return classifyFailureLine(t) === undefined && isSuccessLine(t);
}

/**
 * The lines the default-refuse rule may judge: neither the harness's nor a PASSING check.
 *
 * Both exclusions are about WHO WROTE THE LINE, never about what it says — see {@link
 * isHarnessLine} and {@link isPassingLine}, the latter of which carries the counter veto for the
 * passing side. What is left is every failure line the classifier read plus everything it did
 * not, and the second group is exactly the group that must be vouched for by {@link
 * isKnownCleanLine} or refuse.
 *
 * THE INVARIANT, asked before both exclusions and the ONLY place it is enforced: a line whose own
 * text declares a failure ({@link declaresFailure}) stays judgeable, whatever it opens like. Every
 * arm that removes a line from judgement — the harness's `tier-said-` / `Exit code:` / `$ ` shapes,
 * and the classifier's pass arms — vouches for a line by its OWN shape and stops reading there,
 * which is exactly where a runner's verdict lives: `$ not ok 1 - t/brand_new.t - boom` is the
 * executor's trace prefix glued to a TAP failure, and `not ok 5 - brand new check 9 passed` is a
 * TAP failure the classifier reads as SUCCESS on its unanchored `\d+ passed` arm. Neither may walk
 * out through a door built for harness writing and passing checks.
 *
 * One span is exempt from the invariant, and it is the harness's own writing rather than a line's:
 * the `Command failed:` / `$ ` / `+ ` prefixes and the other harness arms' words (`killed`, `Exit
 * code`) are the executor's sentences, printed on every failed command. That is why the invariant
 * is asked of {@link harnessWordsRemoved} here and of the echoed command in {@link isHarnessEchoOf}
 * — the same reading {@link isHarnessLine} already takes — and not of the raw line. A gate line
 * that merely QUOTES a harness sentence still carries its words as content, and the echo arm's own
 * shape test requires the prefix at the head of the line, so quoting buys no exemption.
 *
 * The order is what makes this one rule rather than an arm per door: each exemption is a separate
 * predicate that the next shape gets added to, and an invariant asked inside them is an invariant
 * the next shape can be written around. Asked here, first, no arm can reach a line that declares a
 * failure at all. {@link isHarnessEchoOf} asks the same predicate for the same reason, being the
 * one exemption applied outside this filter (it vouches for a line by a fact about the OTHER
 * stream).
 *
 * THE COST, in the safe direction: the harness's own writing about a failure — a `killed by
 * signal` beside nothing else, a command echo whose command contains the word `fail` — now stays
 * in the stream and is compared, so it must match the base's copy or the tier hands back.
 */
export function judgeableLines(stream: string): string[] {
  return streamLines(stream).filter(
    (line) =>
      // THE INVARIANT, asked before both exclusions (see the jsdoc for why this is the one place
      // the rule can live, and for the one span the harness is allowed out of it).
      declaresFailure(harnessWordsRemoved(line)) || (!isHarnessLine(line) && !isPassingLine(line)),
  );
}

/**
 * A line's comparison key: its own tree prefix out, its whitespace collapsed.
 *
 * Digits are NOT folded here. A digit is the finding inside an assertion, so this is the STRICT
 * key — the one that keeps `assert 1 == 2` and `assert 1 == 3` two lines. The one field the
 * comparison folds anywhere is a runner's counters, and only by {@link failureLineFold}.
 *
 * A runner's CHECK INDEX is not folded either (`not ok 3 - x` must not match a base's
 * `not ok 1 - x`), for the same reason every arm here gives: the fold cannot vouch for the whole
 * line. The index is printed in the order the runner ran its checks, so nothing ties the number to
 * the check — a brand new failing check printed third would share the folded key of a base that
 * failed one check first. The accepted cost is a hand-back, never a green: a TAP or bats run whose
 * failing checks were renumbered by an added passing test now refuses.
 */
export function normaliseRaw(line: string, root: string): string {
  return stripRoot(line, root).replace(/\s+/g, " ").trim();
}
