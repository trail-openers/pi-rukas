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
 */

import { classifyFailureLine, isSuccessLine } from "../work-driver-verify-failures.ts";
import { stripRoot } from "./verify-baseline-excuse.ts";

/**
 * A line that reports a check as PASSING, in the dialects the allow-list has to read.
 *
 * Every arm is ANCHORED and every arm admits a passing verdict, never a failing one:
 *
 *   - `ok`, `PASS`, `PASSED`, `✓` as the WORD a line OPENS with (`PASS tests/x.py::t`,
 *     `ok 3 - t/x.t`). The negative lookahead is what keeps `passage`, `okay` and `passive`
 *     from reading as pass markers, and a line opening `FAIL` or `not ok` cannot match;
 *   - a tally that counts PASSED checks (`3 passed`, `12 passed, 0 failed`), where the count
 *     opens the line; and
 *   - go test's per-check lines: `=== RUN   TestX` (a run banner, which carries no verdict)
 *     and `--- PASS: TestX`.
 *
 * This list is never asked alone: {@link isKnownCleanLine} consults the shared classifier
 * first, so a line the table reads as a failure is not admitted here however it is shaped.
 * That ordering is what lets these arms be short anchored words instead of a complete
 * vocabulary of everything runners print — the vocabulary is the classifier's, and
 * duplicating it here is the mistake this module's existence is a correction of.
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
 */
const PROGRESS_LINE = /^[\s./\\A-Za-z0-9_[\]%<>:-]*[.sx][\s.]*\[\s*\d+[\d.,]*%?\s*\]\s*$/;

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
 * What this arm exists for is the case those two rules settle and a naive allow-list would get
 * wrong: a suite ALREADY RED at base, to which this PR ADDS PASSING tests. Its summary counts
 * differently from the base's (`5 passed` where the base printed `3 passed`), and an excuse
 * that read a moved count as a new failure line would refuse the one case it exists to grant.
 * A tally the table does not read as a failure, whose every failure line the base also printed,
 * is a runner counting its own run — and a count is not evidence about which checks failed.
 */
const RUN_SUMMARY =
  /^[\s=*_~.,:-]*(?:[A-Za-z][\w. -]{0,24}:\s*)?(?:\d[\d.]*\s+\w+[\w.,-]*\s*,?\s*){1,6}(?:in\s+[\d.]+\s*(?:ms|s|sec|secs|minutes?)?\s*)?[\s=*_~.,-]*$/i;

/** Runner padding, which the tally arms read as decoration and must not read as content. */
const PADDING = /^[\s=*_~.,:-]+|[\s=*_~.,:-]+$/g;

/**
 * A tally's NON-ZERO count of things that did not pass — `1 failed`, `2 errors`.
 *
 * Requiring the count to be non-zero and to sit in a tally position is what tells apart the
 * two lines a runner prints: `5 passed` counts a clean run, so its number may move freely
 * between base and head and the excuse NEEDS it to; `1 failed, 5 passed` counts a FAILURE, and
 * a number that moved because a check broke is precisely the evidence the excuse must not wave
 * through — inside such a tally nothing distinguishes "+2 passing, the PR added checks" from
 * "+2 failing, the PR broke one", and the rule fails on the side that cannot produce a green.
 * Zero counts (`0 failed`) are the clean case and stay excusable, which is why the digit is
 * `[1-9]` and not `\d`.
 *
 * The classifier reads a non-zero counted tally as a FAILURE LINE and a failing-free tally as a
 * passing line, so this guard holds the allow-list to the reading the table already gives —
 * asked independently, so no padding or prefix can talk the tally arm into a pass.
 */
const FAILURE_WORD =
  /(?:^|\D[\s=*_~.,:-]*)[1-9]\d*\s+(?:failed|failing|failures?|errors?|fatal|critical)\b/i;

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
 * The whole allow-list of the default-refuse rule, in one place: pass markers, go's run and
 * pass lines, a pure progress line, a separator, a passing tally, a plan, a collection count.
 * The DIRECTION is the point and it is the opposite of the rule this replaced: a shape this
 * list has never heard of REFUSES, which costs a hand-back, and is never read as clean, which
 * would cost a green. So the list may be imperfect only in the safe direction, and a new
 * runner's failure dialect needs no change here to be CAUGHT — only to be excused.
 *
 * The classifier is asked FIRST: a line the table reads as a failure is never clean, whatever
 * else it looks like. That single ordering is what keeps the arms above from having to be
 * exhaustive — `✗ x` opens like a pass glyph, `--- FAIL:` and `FAIL x` carry the same letters
 * as a pass marker, and a `FAILURES!` banner is built from separator characters. The classifier
 * answers for all of them before any arm here is consulted, and no arm here has to argue with
 * the table.
 */
export function isKnownCleanLine(line: string): boolean {
  if (classifyFailureLine(line) !== undefined) return false;
  return (
    PASS_MARKER.test(line) ||
    GO_RUN_LINE.test(line) ||
    PROGRESS_LINE.test(line) ||
    SEPARATOR_LINE.test(line) ||
    (RUN_SUMMARY.test(line.trim().replace(PADDING, "")) && !FAILURE_WORD.test(line)) ||
    TAP_PLAN.test(line) ||
    COLLECTION_LINE.test(line)
  );
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
  const t = line.trim();
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
 */
function isPassingLine(line: string): boolean {
  return classifyFailureLine(line) === undefined && isSuccessLine(line);
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
 */
export function isHarnessEchoOf(
  headLine: string,
  baseRawLines: readonly string[],
  tierCommand: string | undefined,
): boolean {
  const t = headLine.trim();
  if (!/^Command failed:\s/.test(t)) return false;
  const echoed = t.slice("Command failed:".length).trim();
  if (echoed.length === 0) return true;
  if (tierCommand !== undefined && echoed === tierCommand.trim()) return true;
  return baseRawLines.some((line) => line === echoed || line.includes(echoed));
}

/**
 * Every raw line of a stream, trimmed, blanks dropped.
 *
 * Exported because the two rules that read a whole stream live on either side of the module
 * seam and must ask the SAME question of it — anything else is two definitions of "a line".
 */
export function streamLines(stream: string): string[] {
  return stream
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The lines the default-refuse rule may judge: neither the harness's nor a PASSING check.
 *
 * Both exclusions are about WHO WROTE THE LINE, never about what it says — see {@link
 * isHarnessLine} and {@link isPassingLine}. What is left is every failure line the classifier
 * read plus everything it did not, and the second group is exactly the group that must be
 * vouched for by {@link isKnownCleanLine} or refuse.
 */
export function judgeableLines(stream: string): string[] {
  return streamLines(stream).filter((line) => !isHarnessLine(line) && !isPassingLine(line));
}

/**
 * A line's comparison key: its own tree prefix out, its whitespace collapsed.
 *
 * Digits are NOT folded here. A digit is the finding inside an assertion, so this is the STRICT
 * key — the one that keeps `assert 1 == 2` and `assert 1 == 3` two lines. The single field a
 * runner may move is folded separately, and only by {@link leadingIndexFolded}.
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
