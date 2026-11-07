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
 * That direction is the entire design, and it was not the first one. `failureLines` drops
 * every line the shared classifier does not recognise, so an omitted line let a head of
 * `[readable A, unread B]` match a base that printed only A and grade a tier GREEN on a
 * failure this run authored — the one outcome the feature must never produce. The first fix
 * kept a list of failure TOKENS (`not ok`, `--- FAIL:`, a `FAIL` word with a name,
 * `FAILED`/`ERROR` at the start) and refused on a head-only token the table had not read.
 * Runners are unbounded and every review round produced a token the list lacked, which is
 * how a list of what-is-a-failure rots. So the question is asked the other way round now:
 * the list here holds what is NOT a failure — pass markers, progress lines, separators,
 * counts — and it is short precisely because that set is small and stable. A new runner's
 * failure dialect is caught by being absent from it, needing no change here to be caught and
 * only a change here to be excused.
 *
 * Two exclusions are applied to both streams before any comparison, and both are about WHO
 * WROTE the line rather than what it says: the harness's own writing (the executor's kill and
 * echo lines, which never came from the gate) and any line the classifier positively reads as
 * a PASSING check (a PR that adds passing tests prints new ones of those every run). Neither
 * is an exemption from the rule — a line that survives both filters and matches nothing is
 * refused on its face, whatever it opens with.
 *
 * EVERY arm here vouches for the WHOLE LINE, which is what the third round of this rule
 * established. Three arms used to read only as far as their own shape reached — a pass-marker arm
 * that read the leading `ok`, a progress arm that read the run's length but not its glyphs, a
 * tally arm that folded any number with a known counter word next to it — and each let through a
 * line that went on to say the opposite (`ok, the brand new deploy check failed`, a result row
 * carrying an `F`, `===== 999 crashed, 9 passed =====`). Two rules make the whole-line promise
 * mechanical: {@link declaresFailure} vetoes any line whose text carries a failure word or a
 * failure glyph ANYWHERE in it, and {@link COUNTER_WORDS} admits a counted word only by being on
 * an explicit list of things a runner counts that did not go wrong — absence refuses. The cost of
 * the first is accepted and documented: a PASSING test whose NAME contains such a word, when the
 * line is head-only, is refused, and a refusal is a hand-back, never a green.
 *
 * The comparison keys live here too ({@link normaliseRaw}, {@link failureLineFold}) because WHAT MAY
 * MOVE is the same question as WHAT MAY BE EXCUSED, and it is answered in one place: only a runner's
 * counters, never a failure count, and never anything at all inside a line the classifier read as one
 * check's failure. A second key once folded a TAP check index so that `not ok 3 - x` matched a base's
 * `not ok 1 - x`; it excused a NEW failed check whenever the renumbering was not the whole difference,
 * so it is deleted, and a renumbered failure is refused. See {@link failureLineFold} for the one field
 * the comparison still folds.
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
 * first, so a line the table reads as a failure is not admitted here however it is shaped.
 * That ordering is what lets these arms be short anchored words instead of a complete
 * vocabulary of everything runners print — the vocabulary is the classifier's, and
 * duplicating it here is the mistake this module's existence is a correction of. The veto is
 * not that vocabulary: it is the same idea applied to the text the classifier's anchored shapes
 * do not reach, and it is deliberately WIDER than the table (see {@link declaresFailure})
 * precisely because it is cheap to be wide here and expensive to be wide there.
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
 * WHAT THE RESULT RUN IS MADE OF is the second half of the arm, and the half the class alone
 * left open: `F` is a failed check and `E` an error, and pytest prints them in the SAME run of
 * characters it prints `.` in, so `tests/x.py ....F... [ 50%]` matched the class as printed and
 * was vouched for by an arm that had read only its shape. A result glyph is therefore admitted by
 * name — `.`, `s` (skipped) and `x` (expected-fail) are checks that did not go wrong — and every
 * other character in the row's result run is what {@link PROGRESS_BAD_GLYPH} refuses. A row whose
 * run carries an `F` is not the row the base printed, and the percentage moving with it is the
 * runner counting more checks, not evidence the row is unchanged.
 *
 * The veto reads the run, never the line: `tests/deploy_timeouts.py ..  [100%]` carries `F` and `T`
 * in its NAME and excuses, because a file name is not a verdict. The runner's own whitespace is the
 * seam — path, result run, percentage — so a name can never veto its own row.
 */
const PROGRESS_LINE = /^[\s./\\A-Za-z0-9_[\]%<>:-]*[.sx][\s.]*\[\s*\d+[\d.,]*%?\s*\]\s*$/;

/** A character that is not a passing result glyph. `F` failed, `E` errored, `T` is pytest's timeout. */
const PROGRESS_BAD_GLYPH = /[^.sx]/;

/**
 * Is this progress row's result run made only of passing glyphs?
 *
 * The row is split on the runner's own whitespace and the fields a result run NEVER lives in are
 * dropped: the bracketed percentage (`[100%]`, `[ 50%]`, which splits into `[` and `50%]`), the
 * separator padding a runner pads the row with (`=====`), and anything carrying a path separator,
 * which is the file the row reports on and whose name is not a verdict — `tests/deploy_timeouts.py`
 * has an `F` and a `T` in it and must not veto its own clean row. What is left, and starts with a
 * result glyph, IS the result run, and a single character in it outside `.sx` is a failed check.
 * A row with no such field reports no result at all and comes back not-clean: an arm that excused a
 * row for showing nothing would excuse a row for showing nothing.
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
 * WHY a tally may sit on the allow-list when a bare `FAILURES!` may not, and the one thing it
 * is NOT: it is not a claim that the run PASSED, it is a claim that THE LINE IS A TALLY rather
 * than a verdict about one check. Its safety comes entirely from the two rules around it, both
 * stronger than it is:
 *
 *   - the classifier is asked FIRST ({@link isKnownCleanLine}), and the shared table reads a
 *     counted failing tally (`1 failed`, `2 errors`) and a `FAILURES!` banner as FAILURE
 *     LINES, so a run with a counted failure refuses before this arm is consulted; and
 *   - the tier is excused only when its recognised failure lines ALL match the base's (the set
 *     comparison in `verify-baseline-excuse.ts`), so a tally that moved because a NEW check
 *     broke is describing a failure line the base never printed, and that comparison refuses.
 *
 * Why this arm exists, and the case a naive list would get wrong: a suite ALREADY RED at
 * base, to which this PR ADDS PASSING tests. Its summary counts differently from the base's
 * (`5 passed` where the base printed `3 passed`), and an excuse that read a moved count as a new
 * failure line would refuse the one case it exists to grant. A tally the table does not read as a
 * failure, whose every failure line the base also printed, is a runner counting its own run — and
 * a count is not evidence about which checks failed.
 *
 * The third rule around it is the one that makes that sentence true rather than hopeful: every
 * `<number> <word>` pair the shape matched must count something on {@link COUNTER_WORDS}. The
 * shape answers "is this a tally?" and nothing else, so on its own it admitted `===== 999
 * crashed, 9 passed =====` — `crashed` sat inside the tally arm's `\w+` the same way a counted
 * word of a passing half does. A counted word is admitted by being KNOWN, and refused by being
 * absent, which is the same direction the whole file runs in.
 */
const RUN_SUMMARY =
  /^[\s=*_~.,:-]*(?:[A-Za-z][\w. -]{0,24}:\s*)?(?:\d[\d.]*\s+\w+[\w.,-]*\s*,?\s*){1,6}(?:in\s+[\d.]+\s*(?:ms|s|sec|secs|minutes?)?\s*)?[\s=*_~.,-]*$/i;

/** Runner padding, which the tally arms read as decoration and must not read as content. */
const PADDING = /^[\s=*_~.,:-]+|[\s=*_~.,:-]+$/g;

/**
 * The words a runner counts that did NOT go wrong, as one closed set: `9 passed`, `2 skipped`.
 *
 * Owned by `verify-baseline-counters.ts`, where the reasoning for the closed set lives, and read
 * HERE as well so the two rules that judge a runner's numbers cannot drift apart: the tally arm of
 * {@link isKnownCleanLine} admits a summary only when EVERY `<number> <word>` pair names a word on
 * it, and {@link failureLineFold} folds a digit only when its neighbour is one of them. A word on the
 * list is therefore both excusable and foldable, and a word off it is neither — which is why a new
 * runner whose summary counts something unnamed needs exactly one edit, in one place, and why a new
 * failure word needs no edit at all to be CAUGHT.
 */
/** {@link COUNTER_WORD_LIST} as a whole word, which is how every reader of it must match it. */
const COUNTER_WORDS = new RegExp(`^(?:${COUNTER_WORD_LIST})(?![A-Za-z0-9])$`, "i");

/**
 * A `<number> <word>` pair whose word is NOT a known counter — `999 crashed`, `3 panicked`.
 *
 * The veto the tally arm and {@link isPassingLine} share, so that ONE question — "does this line
 * count something that is not a counter?" — has ONE answer wherever it is asked. Applied to the
 * trimmed line with {@link PADDING} stripped for the tally arm (the `=====` a pytest summary wears
 * is decoration, not a counted word), and to the bare trimmed line for the passing arm.
 *
 * The word is read AFTER the number, which is how every runner this file has to read spells a
 * tally. The reverse spelling (`Failures: 1`) is not caught here — its word sits BEFORE its number
 * — and that is a deliberate boundary, not a gap: that dialect is one the shared classifier already
 * reads as a failure line, so both {@link isKnownCleanLine} and {@link isPassingLine} refuse it on
 * the classifier's answer and {@link failureLineFold} leaves its digits standing. The counter list
 * answers for the spelled-after dialects and the classifier for the spelled-before ones, so neither
 * mechanism has to become a vocabulary of failure words.
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
 * The DIRECTION is the point and it is the opposite of the rule this replaced: a shape this
 * list has never heard of REFUSES, which costs a hand-back, and is never read as clean, which
 * would cost a green. So the list may be imperfect only in the safe direction, and a new
 * runner's failure dialect needs no change here to be CAUGHT — only to be excused.
 *
 * Two rules apply to EVERY arm rather than to one of them, and together they are what "vouches
 * for the whole line" means in code:
 *
 *   - the classifier is asked FIRST, so a line the table reads as a failure is never clean,
 *     whatever else it looks like (`✗ x` opens like a pass glyph, `--- FAIL:` and `FAIL x`
 *     carry the same letters as a pass marker, a `FAILURES!` banner is built from separator
 *     characters); and
 *   - {@link declaresFailure} vetoes a line whose text carries a failure word or glyph ANYWHERE,
 *     so no arm ends its reading at its own match — an arm vouches for the whole line or not at
 *     all. The classifier's shapes are anchored and cannot see `ok 4 - brand new check FAILED`;
 *     the veto reads the whole line and does.
 *
 * THE COST, accepted: a PASSING test whose NAME contains a failure word — a head-only `ok 7 -
 * login timeout retried` — is vetoed and therefore refused, and the tier hands back instead of
 * excusing. A hand-back costs a human a look; the alternative is a green on a line that named a
 * failure. The veto therefore errs long on the side that cannot produce one, and
 * `docs/lean.md` / the troubleshooting entry state it in the words an operator reads.
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
 * The whole-line veto, {@link declaresFailure}, and the reason no arm above has to be a vocabulary.
 *
 * The pattern and the predicate both live in `verify-baseline-counters.ts`, which owns the ONE
 * vocabulary of what a runner prints for what broke: the same predicate decides what a head-only line
 * may BE here and what a line may MOVE there, so the two rules cannot drift apart on which word counts
 * as a failure. The reasoning for the set — word-bounded `fail\w*` … `leak\w*` plus the glyphs
 * ✗ ✘ × ✕ ✖, wider on purpose than the classifier's anchored shapes, because being wide costs a
 * hand-back and being narrow costs a green — lives with it there.
 *
 * Each arm above vouches for the shape it matched and stops reading there, which is exactly where a
 * runner's report of what went wrong lives: `ok 4 - brand new check FAILED` and `ok 3 - t/release.t
 * the publish step failed` each open with a genuine pass marker in a genuine dialect and say, in the
 * part no arm read, that something failed. The classifier does not catch those — its shapes are
 * anchored (`not ok`, `FAILED <path>::`, `--- FAIL:`) and none of these matches one — so this is the
 * arm that does, and it is asked of every candidate.
 *
 * {@link COUNTER_WORDS} is the mirror image of this rule for a tally's counted words, and the same
 * direction.
 */

/**
 * Every raw line of a stream, scrubbed of invisible characters, trimmed, blanks dropped.
 *
 * Exported because the two rules that read a whole stream live on either side of the module
 * seam and must ask the SAME question of it — anything else is two definitions of "a line",
 * and with {@link scrubInvisible} in the seam, two definitions of "the text of a line". Every
 * single-line arm in this file scrubs its own argument too, so a caller holding a raw line gets
 * the same answer as a line that came through a stream.
 */
/**
 * Does the shared classifier read this line as a check that PASSED?
 *
 * `classifyFailureLine` answers `undefined` for BOTH a passing line and a line it does not
 * know, and the two must not be treated alike: an unread line is a failure nobody read and gets
 * no exemption (that is the whole of the default-refuse rule), while a line the classifier
 * positively reads as success is a runner reporting a passing check — and a PR that adds passing
 * tests prints new ones of those on every run. The distinction is the classifier's own, which is
 * why this asks IT rather than keeping a second vocabulary of pass markers that could drift from
 * the table that decides what a failure is.
 *
 * The whole-line veto is asked HERE too, and that is load-bearing rather than tidy: this is the
 * OTHER door a head-only line walks out through, since a line excluded as "passing" never reaches
 * {@link isKnownCleanLine} at all. `ok 4 - brand new check FAILED` is read as SUCCESS by the
 * classifier — its `\d+\s+passed` arm is an UNANCHORED substring search that fires on the `4` and the
 * `FAILED` of a TAP line — so a pass marker the classifier guessed made a failing check's line exempt
 * from every rule in this file. No exemption survives the line's own words saying something broke,
 * which is what {@link declaresFailure} asks here as well as in {@link isKnownCleanLine}.
 *
 * ONE class of line is exempt from the veto at this door, and it is the reason the veto is not simply
 * asked first: a runner's COUNTED SUMMARY of a red run — `===== 1 failed, 5 passed in 0.42s =====` —
 * legitimately names failures, is read as success by that same arm, and is the line the
 * added-passing-tests case MOVES (`3 passed` → `5 passed`). Refusing it here refused the one case the
 * excuse exists to grant. So a line that is a tally is judged by {@link UNKNOWN_COUNTED_WORD} instead
 * of by the word list: every count it carries must name a word on {@link COUNTER_WORD_LIST}, or the
 * exemption goes. `999 crashed` has a tally's shape and a counted word on no list, so it is refused —
 * which is the split the classifier cannot draw for itself, because `crashed` and `passed` reach its
 * success arm identically.
 *
 * What the two arms together leave in the stream is the set that makes the rest of the design work.
 * A clean pass line (`PASSED tests/x.py::t`, `ok 1 - a check`) leaves both streams together and cannot
 * make a head-only line, so exempting it costs nothing. A counted summary of a red run is NOT exempt —
 * `failed` is no counter — so it stays in the stream, is read by {@link failureLineFold}, and the one
 * field a PR's added checks move is folded there, which is the pass `baselineExcuse` exists to give.
 * Exempting THAT line by the classifier's success arm is what refused the field case: an exempted
 * summary is compared by nothing, so a head whose summary moved had no key and no exemption, and the
 * tier was refused by the very rule meant to grant it.
 */
function isPassingLine(line: string): boolean {
  const t = scrubInvisible(line);
  const tally = t.trim().replace(PADDING, "");
  // The tally arm keeps its OWN gate ({@link UNKNOWN_COUNTED_WORD}) rather than the word veto, and
  // the ordering is load-bearing: a runner's summary of a red run — `===== 1 failed, 5 passed in
  // 0.34s =====` — legitimately names failures, is read as success by the classifier's unanchored
  // `\d+ passed` arm, and is THE line the added-passing-tests case moves. A word veto asked of the
  // whole line refuses it, and an exempted summary is compared by nothing, so the tier whose summary
  // moved had no key and no exemption: the veto in front of this arm refused the one case the excuse
  // exists to grant. What the arm still may not vouch for is a counted word on no list, which is
  // exactly what the counter veto below asks, and a TAP verdict wearing a pass count (`not ok 5 -
  // brand new check 9 passed`) has a tally's shape and a `not ok` its own.
  if (RUN_SUMMARY.test(tally))
    return !UNKNOWN_COUNTED_WORD.test(tally) && !declaresFailure(harnessWordsRemoved(tally));
  if (declaresFailure(harnessWordsRemoved(t))) return false;
  return classifyFailureLine(t) === undefined && isSuccessLine(t);
}

export function streamLines(stream: string): string[] {
  return stream
    .split(/\r\n|\r|\n/)
    .map((line) => scrubInvisible(line).trim())
    .filter((line) => line.length > 0);
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
 * TAP failure the classifier reads as SUCCESS on its unanchored `\d+ passed` arm. Neither is gate
 * output in the sense the exemption is about, and neither may walk out through a door built for
 * harness writing and passing checks.
 *
 * One span is exempt from the invariant, and it is the harness's own writing rather than a line's:
 * the `Command failed:` / `$ ` / `+ ` prefixes and the other harness arms' words (`killed`, `Exit
 * code`) are the executor's sentences, printed on every failed command, and a runner declaring a
 * failure is not what they are. That is why the invariant is asked of {@link harnessWordsRemoved}
 * here and of the echoed command in {@link isHarnessEchoOf} — the same reading {@link isHarnessLine}
 * already takes — and not of the raw line. A gate line that merely QUOTES a harness sentence
 * (`Command failed: touch /tmp/pwned` printed by the project's own script) still carries its words
 * as content, and the echo arm's own shape test requires the prefix to sit at the head of the line,
 * so quoting it does not buy an exemption.
 *
 * The order is what makes this one rule rather than an arm per door. Each exemption is a separate
 * predicate that a future round will add another shape to, and an invariant asked inside them is
 * an invariant the next shape can be written around — which is how pass 6 left these two doors
 * open while closing the other two. Asked here, first, no arm can reach a line that declares a
 * failure at all: the exemptions are consulted only for lines this test has already released.
 * {@link isHarnessEchoOf} asks the same predicate for the same reason, being the one exemption
 * applied outside this filter (it vouches for a line by a fact about the OTHER stream).
 *
 * THE COST, in the safe direction and the same one {@link declaresFailure} already pays: the
 * harness's own writing about a failure — a `killed by signal` beside nothing else, a command echo
 * whose command contains the word `fail` — now stays in the stream and is compared, so it must
 * match the base's copy or the tier hands back. A hand-back costs a human a look; the alternative
 * is excusing a line that said something broke.
 */
export function judgeableLines(stream: string): string[] {
  return streamLines(stream).filter(
    (line) =>
      // THE INVARIANT, asked before both exclusions: a line whose own text declares a failure
      // ({@link declaresFailure}, on the line with the harness's own prefix discounted) is not an
      // exemption's to remove, whatever it opens like. See the jsdoc for why this is the one place
      // the rule can live, and for the one span the harness is allowed out of it.
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
 * The key that used to fold a runner's CHECK INDEX (`not ok 3 - x` onto a base's `not ok 1 - x`)
 * is deleted, and the reason is the same rule this file runs on everywhere else: the fold cannot
 * vouch for the whole line. A check index is printed by the runner in the order it ran its checks,
 * so nothing ties the number to the check — a brand new failing check printed third shares the
 * folded key of a base that failed one check first, and the run that authored it is excused. The
 * accepted cost is the opposite direction and a hand-back, never a green: a TAP or bats run whose
 * failing checks were RENUMBERED, because a passing test was added before them, now refuses.
 */
export function normaliseRaw(line: string, root: string): string {
  return stripRoot(line, root).replace(/\s+/g, " ").trim();
}
