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
 * The comparison keys live here too ({@link normaliseRaw}, {@link failureLineFold},
 * {@link leadingIndexFolded}) because WHAT MAY MOVE is the same question as WHAT MAY BE
 * EXCUSED, and it is answered in one place: only a runner's counters, never a failure count, and
 * never anything at all inside a line the classifier read as one check's failure.
 *
 * And every arm reads the SAME text, because {@link scrubInvisible} runs once where the lines
 * are read: a word split by a zero-width space (`fa\u200biled`) is invisible to the eye, to
 * {@link declaresFailure}'s word-bounded vocabulary, and to the classifier's anchored shapes,
 * so a rule that normalised in only one arm would be a rule the other arms did not apply.
 */

import { classifyFailureLine, isSuccessLine } from "../work-driver-verify-failures.ts";
import { COUNTER_WORD_LIST, failureLineFold, scrubInvisible } from "./verify-baseline-counters.ts";
import { stripRoot } from "./verify-baseline-excuse.ts";

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
 * Does this line's own text declare a failure, anywhere in it?
 *
 * The whole-line veto, and the reason no arm above has to be a vocabulary. Each arm vouches for
 * the shape it matched and stops reading there, which is exactly where a runner's report of what
 * went wrong lives: `ok 4 - brand new check FAILED`, `ok, the brand new deploy check failed` and
 * `ok 3 - t/release.t the publish step failed` each open with a genuine pass marker in a genuine
 * dialect and say, in the part no arm read, that something failed. The classifier does not catch
 * those — its shapes are anchored (`not ok`, `FAILED <path>::`, `--- FAIL:`) and none of these
 * matches one — so this is the arm that does, and it is asked of every candidate.
 *
 * The words are a fixed set, matched case-insensitively and WORD-BOUNDED (`fail\\w*` reaches
 * `failed`, `failing`, `failures`; it does not reach `focus` or `definitely`), plus the five
 * failure glyph runners actually print (`✗ ✘ × ✕ ✖`), which have no letters to bound. The set is
 * wide on purpose — it reaches further than the classifier's anchored shapes, on purpose — and it
 * is asked only of the lines this module is asked about, never of a stream: being wide here costs a
 * hand-back for a passing test whose name happens to read like a failure (`ok 7 - login timeout
 * retried` printed head-only), while being narrow here costs a green on a line that said it broke.
 * {@link COUNTER_WORDS} is the mirror image of this rule for a tally's counted words, and the same
 * direction.
 */
const FAILURE_VETO =
  /\b(?:fail\w*|error\w*|crash\w*|abort\w*|panic\w*|timed?\s*out|timeout|segfault|broken|exception\w*|fatal|critical|killed|leak\w*)\b|[✗✘×✕✖]/i;

/** The line's own words, anywhere in it, say something went wrong. */
export function declaresFailure(line: string): boolean {
  // Scrubbed for the same reason as every arm here: the veto IS the whole-line rule, and a word split
  // by an invisible character is the word — a veto that read the raw text would be the one arm that
  // still saw `fa\u200biled` as ordinary text while everything else saw `failed`.
  return FAILURE_VETO.test(scrubInvisible(line));
}

/**
 * Did the HARNESS write this line, rather than the gate?
 *
 * The streams the excuse reads are BUILT by the executor, which adds its own writing to what
 * the gate printed: a `tier-said-<name>` marker, a `boom from the <tier>`, a bare `Exit code:
 * N`, a bare `killed`, an echoed `$ command`. None of it is evidence about the project, so the
 * default-refuse rule must not read it as a gate line — and it must not read it on EITHER
 * side, because the head stream carries executor noise the base stream need not carry
 * identically, and counting that as head-only would refuse every real tier in the suite.
 *
 * The arms are anchored to the harness's OWN full-line forms, exactly as `isHarnessEchoLine`
 * anchors the shared table's: a bare `Exit code: 1` is the harness, while `Exit code: 1 - brand
 * new check` is a gate line that merely OPENS that way and is judged on what it says. An
 * exemption that reached the second form would hand the whole rule back to whoever controls the
 * first word of a line.
 */
export function isHarnessLine(line: string): boolean {
  const t = scrubInvisible(line).trim();
  return (
    /^tier-said-[A-Za-z0-9_-]+(?:-\d+)?$/.test(t) ||
    /^boom from the [A-Za-z0-9_ -]+$/.test(t) ||
    /^Exit code:\s*\d*$/.test(t) ||
    /^killed(?:\s+by\s+signal\s*\S*)?$/i.test(t) ||
    /^\$\s/.test(t)
  );
}

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
  if (RUN_SUMMARY.test(tally)) return !UNKNOWN_COUNTED_WORD.test(tally);
  if (declaresFailure(t)) return false;
  return classifyFailureLine(t) === undefined && isSuccessLine(t);
}

/**
 * Is this head line the harness ECHOING a command, and did the base echo the same command?
 *
 * `Command failed: <cmd>` is the executor quoting back what it ran. It is not gate output, and
 * the same tier at the base is echoed the same way, so an echo is not a failure this run
 * authored — PROVIDED the base really printed that command, or it is the tier's own command
 * (which the caller passes, because the base stream of a single-tier probe need not repeat it).
 * That proviso is what keeps the exemption honest: an echo of a command NEITHER run was asked to
 * run is a head-only line like any other, and a head carrying only such an echo has nothing
 * recognised left to compare, which is what refuses it.
 *
 * The command is NEVER read back out of the stream being judged. It is the tier's real command,
 * which only the CALLER knows — the thing `verify`/`ci` asked the executor to run — and a rule
 * that mined the expected command out of the head stream would let a head-only `Command failed:
 * touch /tmp/pwned` quote itself into being the command the tier ran.
 *
 * The base's copy vouches only when the base printed the IDENTICAL RAW LINE — `l.trim() ===
 * headLine.trim()`, the whole echo including its own `Command failed:` marker. Comparing the
 * STRIPPED command against the base's raw lines inverted the arm: a base carrying the bare command
 * as gate output (`touch /tmp/pwned`) vouched for a head echo nothing asked to run, while the base's
 * own identical echo line did not vouch at all. A base that ran the tier echoes the tier, so the
 * identical echo is exactly the evidence the arm may read, and a line that only MENTIONS the command
 * — a `make check` that quoted the pnpm invocation in its own output, a bare command the runner
 * printed itself — records that the base named it, not that the harness echoed it. With no
 * caller-supplied command that identical echo is the ONLY vouchsafe, and an echo the base did not
 * print is a head-only line like any other — including an empty echo, which names no command at all
 * and so proves nothing.
 */
export function isHarnessEchoOf(
  headLine: string,
  baseRawLines: readonly string[],
  tierCommand: string | undefined,
): boolean {
  const t = scrubInvisible(headLine).trim();
  if (!/^Command failed:\s/.test(t)) return false;
  const echoed = t.slice("Command failed:".length).trim();
  if (echoed.length === 0) return false;
  const asked = tierCommand?.trim();
  if (asked !== undefined && asked.length > 0 && echoed === asked) return true;
  // The WHOLE head line, marker included, compared to the whole base line. Stripping the marker
  // before this comparison is what inverted the arm (see the jsdoc).
  return baseRawLines.some((line) => line.trim() === t);
}

/**
 * Every raw line of a stream, scrubbed of invisible characters, trimmed, blanks dropped.
 *
 * Exported because the two rules that read a whole stream live on either side of the module
 * seam and must ask the SAME question of it — anything else is two definitions of "a line",
 * and with {@link scrubInvisible} in the seam, two definitions of "the text of a line". Every
 * single-line arm in this file scrubs its own argument too, so a caller holding a raw line gets
 * the same answer as a line that came through a stream.
 */
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
 */
export function judgeableLines(stream: string): string[] {
  return streamLines(stream).filter((line) => !isHarnessLine(line) && !isPassingLine(line));
}

/**
 * A line's comparison key: its own tree prefix out, its whitespace collapsed.
 *
 * Digits are NOT folded here. A digit is the finding inside an assertion, so this is the STRICT
 * key — the one that keeps `assert 1 == 2` and `assert 1 == 3` two lines. What a runner may
 * move is folded separately and only by {@link failureLineFold} and {@link leadingIndexFolded}.
 */
export function normaliseRaw(line: string, root: string): string {
  return stripRoot(line, root).replace(/\s+/g, " ").trim();
}

/**
 * A line with its CHECK INDEX folded — the only field a runner is allowed to move.
 *
 * The index is the digits a runner prints immediately after its status word (`not ok 3 - x`,
 * `ok 12 - t/x.t`), and it is the one thing that shifts when a test is ADDED before the check.
 * Everything else stays byte-for-byte, because the check's identity and its assertion ARE the
 * line: `assert 1 == 2` beside `assert 1 == 3`, or `expected 3 to be 4` beside `expected 3 to
 * be 5`, are two defects, and a fold of the whole line would excuse a regression the base never
 * printed — the exact outcome the excuse exists to refuse. A line that does not open with a
 * status word (`FAILED tests/x.py::t - assert 1 == 2`) comes back unchanged: nothing a
 * renumbering touches sits at its front.
 */
export function leadingIndexFolded(line: string): string {
  return line.replace(/^((?:not\s+)?ok)\s+\d+(?:\.\d+)?\b/i, "$1 #").trim();
}
