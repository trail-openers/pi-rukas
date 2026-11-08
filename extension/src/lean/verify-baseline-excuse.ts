/**
 * lean/verify-baseline-excuse — a tier red at HEAD whose every failure the base
 * run ALSO printed is not this run's failure.
 *
 * `verify-baseline.ts` asks whether the base is red at all and hands the run back
 * when it is. That answer is correct but expensive: a mainline whose own suite is
 * red on this host hands back every run of a perfectly good change, and a build
 * round could not fix a gate the base authored. This module asks the narrower
 * question — WHICH lines did each run print as failing — and answers "grade it
 * green, and say so" when the head run printed nothing the base run did not print.
 *
 * The unit of comparison is the WHOLE failure line, and that is what makes it
 * runner-agnostic. A parser that reads a test name out of each line and compares tokens always
 * finds a way to fold two different checks onto one token, and a folded name excuses a failure
 * only this run authored — the one thing this feature must never do. Whole lines cannot fold: two
 * checks are two lines, and two runs of ONE check print the SAME line.
 *
 * It is deliberately stricter than "the base was red too":
 *
 *   - lines come from `failureLines` / `classifyFailureLine`, so the excusable set
 *     is exactly the shapes the shared classifier recognises — pytest, TAP/bats, go,
 *     a script tally, a `FAIL` header, the driver's own diagnostic dialect. A runner
 *     outside that table prints nothing the excuse can read, names nothing, and
 *     excuses nothing;
 *   - the compared text is the classifier's own accepted view of a line — its
 *     trimmed text — with the run's own worktree root out of it, and both sides read
 *     the SAME full text: the classifier's table, {@link failureLinesOf}'s comparison
 *     key, and the recorded set are all the whole line.
 *   - one rule decides what the excuse may not see, and it REFUSES rather than
 *     omitting, in BOTH directions of ignorance. A line past {@link FAILURE_LINE_SCAN_MAX}
 *     refuses either side, because a judge that saw only its first 8 KiB cannot tell two
 *     long lines apart. And a line that is HEAD-ONLY — one the base stream did not print —
 *     refuses unless something POSITIVE vouches for it, which is {@link
 *     hasHeadOnlyUnrefusedLine} asking {@link isKnownCleanLine}. That second half is
 *     DEFAULT-REFUSE and the direction is the whole design: `failureLines` drops every line
 *     the classifier does not recognise, so an omitted one would let a head of
 *     `[readable A, unread B]` match a base that printed only A and grade a tier green on a
 *     failure this run authored. A head-only line needs permission, not a pardon: it is
 *     excused only if it is provably not a failure (a pass marker, a progress line, a
 *     separator, a count), and a new runner's failure dialect is caught by being absent from
 *     that short list. Lines the harness itself wrote, and lines the classifier reads as
 *     PASSING checks, are excluded from both sides — neither is gate output — but no
 *     exemption is given to any prefix of a gate line: a line missing from the base refuses
 *     whatever it opens with.
 *   - both sets must be non-empty and EVERY head line must equal a base line. One
 *     line the head printed and the base did not is a failure this run authored, and
 *     a changed reason is a different line;
 *   - the two trees must still be two trees. Compared in one tree every line is its
 *     own echo and the comparison proves nothing about which run printed what;
 *   - a base run whose red looks like a missing dependency tree is not evidence
 *     the commit is red, it is evidence the probe was not provisioned.
 *
 * "Could not tell" is never an excuse, and the caller falls back to exactly the
 * hand-back `verify-baseline.ts` produced before this module existed.
 */

import { realpathSync } from "node:fs";
import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine,
  failureLines,
} from "../work-driver-verify-failures.ts";
import {
  PREEXISTING_BASE_NAMES_CAP,
  PREEXISTING_NAMES_CAP,
  PREEXISTING_NAME_MAX_CHARS,
  type PreexistingTierRecord,
  preexistingFailuresProblem,
} from "./state-outcome-maps.ts";
import {
  isKnownCleanLine,
  judgeableLines,
  normaliseRaw,
  streamLines,
} from "./verify-baseline-allow-list.ts";
import { failureLineFold } from "./verify-baseline-counters.ts";
import { isHarnessEchoOf } from "./verify-baseline-harness.ts";
import type { BaseProbe } from "./verify-baseline.ts";

/** Why the base red cannot excuse this tier's red. */
export type BaselineExcuse =
  | { kind: "excused"; record: PreexistingTierRecord }
  | { kind: "refused" };

/**
 * Does the HEAD stream print any line the base stream did not, that is not known clean?
 *
 * The default-refuse gate, and the whole of what the excuse may not see. The allow-list it
 * consults lives in `verify-baseline-allow-list.ts` and carries the reasoning for the
 * direction; what stays here is the COMPARISON that direction is applied to, because "head-only"
 * is a question about two streams and cannot be answered by either alone.
 *
 * A line is not head-only if the base printed it too (the same text standing on both streams
 * cannot be a failure this run authored), and not head-only if the harness wrote it or if the
 * classifier reads it as a passing check — both exclusions are applied to BOTH sides by {@link
 * judgeableLines}, so they cannot be traded away by putting noise on one stream only.
 *
 * Comparison is strict by design (see {@link normaliseRaw}), with exactly ONE looser key, and it
 * folds ONE field — nothing else, and never inside a line the classifier read as a failure:
 *
 *   - the RUNNER COUNTERS and durations of a line the classifier did NOT read as a failure
 *     ({@link failureLineFold}), which a PR that ADDS PASSING TESTS moves in the summary of an
 *     already-red suite (`1 failed, 5 passed` where the base printed `1 failed, 3 passed`). Every
 *     number attached to a FAILURE word is kept exact by that fold, so `1 failed` never becomes
 *     equal to `2 failed` by any route — including a digit a LABEL sits in front of (`suite ran: 1
 *     failed`, `tests: 1 failed`, `1 items failed`), which is refused before any counter arm is
 *     asked; and a per-check failure line — `FAILED a.py::t - … got 5 items`, `not ok 1 - checkout -
 *     expected 3 items found 0` — is not folded at all, because the number an assertion compared IS
 *     the finding and a counter word beside it does not make it a tally. Two lines that differ only
 *     by such a number are two failures, and the run that printed the one the base did not is refused.
 *
 * A TAP runner's CHECK INDEX is never folded: a head's `not ok 3 - x` must not sit where the base
 * printed `not ok 1 - x`. The index is assigned by the order checks ran, so it cannot vouch for a
 * line — a NEW failing check printed third would fold onto the base's first failing check and the
 * run that authored it would be excused. The accepted cost, in the safe direction, is that a TAP or
 * bats run whose failing checks were renumbered because a passing test was added before them now
 * refuses: a hand-back, never a green.
 *
 * A line the strict key cannot place is otherwise excused only by the allow-list, never by
 * looser text — which is what makes the direction safe.
 *
 * The one exemption that is not a property of the line's own text is the harness's `Command failed:`
 * echo, and its expected command is therefore a parameter, {@link tierCommand}, never something read
 * back out of the stream being judged: a rule that mined the expected command from the head stream
 * let one head-only `Command failed: touch /tmp/pwned` quote ITSELF into being the command the tier
 * ran and excuse the run. So the caller hands in what it actually asked the executor to run, and with
 * no caller command the base's own copy of the identical raw echo line is the only thing that
 * vouches for an echo — a base line that merely carries the command without the marker does not,
 * including an empty echo, which names no command and proves nothing.
 *
 * The one case the base's copy does NOT excuse is a stream whose recognised set is EMPTY: with
 * nothing the classifier read there is no comparison to grade, and {@link baselineExcuse} refuses
 * below on the empty set. That is what stops a base that printed nothing meaningful from being
 * read as evidence the base was red.
 */
export function hasHeadOnlyUnrefusedLine(
  headStream: string,
  baseStream: string,
  headRoot: string,
  baseRoot: string,
  tierCommand: string | undefined,
): boolean {
  const baseStrict = new Set(
    judgeableLines(baseStream).map((line) => normaliseRaw(line, baseRoot)),
  );
  const baseCounters = new Set(
    [...baseStrict].map(failureLineFold).filter((line) => line.length > 0),
  );
  const baseRaw = streamLines(baseStream);
  return judgeableLines(headStream).some((line) => {
    const key = normaliseRaw(line, headRoot);
    if (key.length === 0 || baseStrict.has(key)) return false;
    if (baseCounters.has(failureLineFold(key))) return false;
    if (isHarnessEchoOf(line, baseRaw, tierCommand)) return false;
    return !isKnownCleanLine(line);
  });
}

/**
 * Does this stream hold a line past the classifier's scan window?
 *
 * The classifier decides such a line on its first 8 KiB, so two lines differing only
 * past the window answer the same and can fold onto one comparison key — the folding
 * this whole module exists to prevent, arriving through length instead of through a
 * token parser. A line no judge fully saw is not evidence, so it refuses on EITHER side
 * and the comparison below reads only lines the classifier saw whole.
 */
function hasOverWindowLine(stream: string): boolean {
  return streamLines(stream).some((line) => line.length > FAILURE_LINE_SCAN_MAX);
}

/**
 * Every line this stream printed as a failure, in stream order, deduplicated and
 * normalised for comparison.
 *
 * Deduplicated because a runner repeats a summary line and a set that counted the
 * repeat would report a failing count the tier did not have. Exported because the
 * caller keeps both runs' streams and must ask the same question of each; each side's
 * tree prefix comes out separately, in {@link baselineExcuse}.
 */
export function failureLinesOf(stream: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of failureLines(stream)) {
    const key = comparableLine(line);
    if (key === undefined || key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * The text two runs' lines are compared as: what the classifier ACCEPTED.
 *
 * "What it accepted" is the classifier's own answer to the question "is this line a
 * failure line?", and the text is the whole trimmed line — no second cut in front of
 * it, because {@link failureLines} already returns the trimmed line it classified and
 * {@link hasOverWindowLine} has already refused any line the window could not show the
 * judge. That is what makes the recorded set replayable: {@link baseStreamOf}
 * writes a recorded line back unchanged, and a line the classifier accepted the first
 * time accepts again, so `ci` compares byte-for-byte the strings `verify` compared.
 *
 * `undefined` for a line the classifier does not recognise — the same veto
 * {@link failureLinesOf} applies, asked here so a caller cannot hand an unread line
 * to the comparison.
 */
function comparableLine(line: string): string | undefined {
  if (classifyFailureLine(line) === undefined) return undefined;
  const accepted = line.trim();
  return accepted.length === 0 ? undefined : accepted;
}

/**
 * One run's tree prefix, out of a line.
 *
 * The tree's own name sits at the FRONT of the part of the line that holds a path: a
 * TAP line is `not ok 1 - <root>/t/x.t - …` and a go line `FAIL <root>/pkg`, so the
 * prefix is measured at the first character that could begin a path (a `/`, a `.` or a
 * Windows drive letter) and NOT at column 0, where the runner's own marker sits. Both
 * spellings are tried — with and without a trailing separator — so a runner that printed
 * `<root>/t/x.t` gives up its tree's text and keeps `t/x.t`, which is what a run in the
 * OTHER tree prints for the same check.
 *
 * The search stops at that first path-shaped character. A root appearing LATER than it
 * is content the tier printed — a path quoted in an assertion, a path in a diff — and
 * the other tree's line carries it too, so a global removal would delete it from one
 * side and not the other, and a difference the excuse erased is a difference it excused.
 *
 * Exported because the allow-list module builds its comparison keys with it, and the two sides
 * of the seam must normalise a path the same way or a line differs by its tree alone.
 */
export function stripRoot(line: string, root: string): string {
  const trimmed = line.trim();
  const pathAt = trimmed.search(/[/.]|[A-Za-z]:/);
  if (pathAt < 0) return trimmed;
  const at = trimmed.slice(pathAt);
  for (const spelling of [root.trim(), root.trim().replace(/\/$/, "")]) {
    if (spelling.length > 0 && at.startsWith(spelling))
      return `${trimmed.slice(0, pathAt)}${at.slice(spelling.length)}`.trim();
  }
  return trimmed;
}

/**
 * A tree resolved to the spelling its own run would have printed it under.
 *
 * `realpath` is not cosmetic: a tree reached through a symlink prints its names
 * under the symlinked spelling while the caller holds the resolved one (or the
 * reverse), and the two never share a prefix. macOS makes every temp dir a
 * symlink, so without this a whole run's lines keep their tree's text and never
 * match. Only the LONGEST EXISTING PREFIX resolves — the probe's own tree is deleted
 * before this comparison runs, and resolving its parent still puts it in the same
 * spelling as every other path here.
 *
 * Called ONCE per {@link baselineExcuse} for each side, never per candidate.
 */
function treeRoot(dir: string): string {
  const parts = dir
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  for (let i = parts.length; i >= 1; i--) {
    // ONE realpath per side, tried longest-prefix-first; the loop terminating without
    // a hit is the answer for a path no part of which exists.
    const candidate = `/${parts.slice(0, i).join("/")}`;
    try {
      const head = realpathSync(candidate);
      const rest = parts.slice(i);
      const base = head.endsWith("/") ? head.slice(0, -1) : head;
      return rest.length === 0 ? base : `${base}/${rest.join("/")}`;
    } catch {
      // Shorten and try again.
    }
  }
  return `/${parts.join("/")}`;
}

/**
 * Is this base run's red the shape of a tree that was never provisioned?
 *
 * `worktree-provision`'s predicate is the vocabulary, but it is written for a single
 * failed gate and its "No such file or directory … node_modules" arm reads the two
 * phrases ANYWHERE in the stream. A tier's own `sh` trace can print both — an
 * interpreter line about a missing binary beside a runner's summary naming the file it
 * could not import — and an excuse may not be refused on text the tier printed ABOUT
 * a file. So a stream excuses nothing only when a FAILURE LINE is individually
 * dependency-shaped: the interpreter's own sentence, not a runner's summary.
 */
function baseRedIsMissingDeps(stream: string): boolean {
  return failureLines(stream).some((line) => MISSING_DEP_LINE.test(line));
}

/** One line the interpreter printed because the tree had no dependencies. */
const MISSING_DEP_LINE =
  /^\s*(?:sh|bash|zsh|npm|pnpm|yarn|bun|node|python\d*|pip\d*|go|cargo|make):\s|Cannot find module|ModuleNotFoundError|error: Cannot find package|command not found|Could not resolve\b/i;

/**
 * May this tier's red be excused over the base run's red?
 *
 * The caller has already settled the colour questions (HEAD red twice, base red,
 * the contract arm) and the frozen acceptance verdict. What is decided here is
 * whether the head run printed anything the base did not; every refusal means the
 * caller keeps the hand-back `verify-baseline.ts` produced before this module.
 *
 * `cmd` is not only the record's label: it is the tier's REAL command, the string the
 * caller handed the executor, and it is what the harness's `Command failed:` echo is
 * allowed to be matched against. A caller that left it out would make every real tier's
 * own echo a head-only line — the base's stream of a single-tier probe need not repeat it —
 * and a caller that took it from the stream would let an echo vouch for itself.
 */
export function baselineExcuse(opts: {
  tierName: string;
  cmd: string;
  baseSha: string;
  /** The base run's colour, already classified by `classifyBaseRun`. */
  probe: BaseProbe;
  /** The head run's combined output stream (the final run of the tier). */
  headStream: string | undefined;
  /** The base run's combined output stream. */
  baseStream: string | undefined;
  /** The run's worktree — where the head run's relative paths live. */
  headRoot: string;
  /** The probe's throwaway tree — where the base run's relative paths lived. */
  probeRoot: string;
}): BaselineExcuse {
  if (opts.probe.status !== "red") return { kind: "refused" };
  const baseStream = opts.baseStream ?? "";
  const headStream = opts.headStream ?? "";
  const head = failureLinesOf(headStream);
  const base = failureLinesOf(baseStream);
  // A line either stream printed past the classifier's window is judged on a clipped
  // view, so it cannot stand as evidence on either side.
  if (hasOverWindowLine(headStream) || hasOverWindowLine(baseStream)) return { kind: "refused" };
  // Both trees resolved ONCE for this comparison, and a probe tree that is the run's
  // own tree — or another spelling of it — compares against nothing: every line is
  // its own echo.
  const headRoot = treeRoot(opts.headRoot);
  const probeRoot = treeRoot(opts.probeRoot);
  if (headRoot === probeRoot) return { kind: "refused" };
  // A bare checkout whose dependencies were never linked fails every command: that
  // red belongs to the probe's provisioning, not to the commit, and no line it
  // prints can stand as evidence the base was red.
  if (baseRedIsMissingDeps(baseStream)) return { kind: "refused" };
  // A head-only line the rule cannot vouch for excuses nothing — see {@link
  // hasHeadOnlyUnrefusedLine}. This is the default-refuse gate: it stands in front of the
  // comparison below so that no line the classifier never read can be excused by absence.
  // The tier's command goes in as the one thing the head stream is not allowed to tell us: an
  // echo is vouched for by what the caller asked to run, or by the base's copy of the identical
  // line, and never by the echo's own text.
  if (hasHeadOnlyUnrefusedLine(headStream, baseStream, headRoot, probeRoot, opts.cmd))
    return { kind: "refused" };
  if (head.length === 0 || base.length === 0) return { kind: "refused" };
  // The text two runs' lines are compared as: each side with ITS OWN tree's prefix out of
  // it and its whitespace collapsed, so head and base agree on what the check WAS, not on
  // where each run ran. Compared TWICE, strictest first, and the tier needs only ONE pass to
  // place EVERY head line:
  //
  //   - the EXACT pass, which is the one that decides anything — it keeps digits, so it is
  //     where `expected 3 to be 4` and `expected 3 to be 5` stay two defects; and
  //   - the RUNNER-COUNTER pass, for the one thing the same PR moves: a runner's summary of the
  //     run. A suite already red at base that GAINS passing tests prints
  //     `===== 1 failed, 5 passed in 0.3s =====` where the base printed `… 3 passed in 0.2s`, and
  //     that summary is a line the comparison below reads — so without this pass the feature
  //     refuses the one case it exists to grant. {@link failureLineFold} keeps every count attached
  //     to a failure word exact, so a summary whose FAILURE count moved has no key here and the
  //     tier still refuses; and it folds NOTHING inside a line the classifier read as one check's
  //     failure, which is what keeps `… got 5 items` and `… got 50 items` two lines — the number an
  //     assertion compared is the finding, and a counter word sitting beside it does not turn a
  //     per-check report into a tally.
  //
  // A TAP runner's CHECK INDEX is never folded: `not ok 3 - x` must not share a key with a base's
  // `not ok 1 - x`, because a runner numbers its checks in the order it ran them and the number says
  // nothing about which check it is. The cost is a renumbered TAP/bats failure handing the run back —
  // never a green.
  //
  // The order is load-bearing. A looser pass is reached only when the passes above it failed
  // for EVERY line, so an assertion whose numbers genuinely changed is settled by the strict
  // pass and refuses; a loose key is never consulted line by line and so can never rescue one
  // shifted failure out of a set that otherwise matched.
  const headKey = head.map((line) => normaliseRaw(line, headRoot));
  const baseKey = new Set(base.map((line) => normaliseRaw(line, probeRoot)));
  if (!headKey.every((line) => line.length > 0 && baseKey.has(line))) {
    const counterHead = headKey.map(failureLineFold).filter((line) => line.length > 0);
    const counterBase = new Set([...baseKey].map(failureLineFold));
    if (!counterHead.every((line) => counterBase.has(line))) return { kind: "refused" };
  }
  const matched = headKey.filter((line) => line.length > 0);
  // The comparison ran on the COMPLETE parsed sets; the caps below bound only what
  // is persisted and rendered. `baseNames` is what lets `ci` reuse this record
  // instead of paying for its own base probe, and an oversized one is omitted
  // rather than truncated: a partial base set would make ci's comparison a lie.
  // A line past the log's own bound is omitted for the same reason — a clipped
  // `baseNames` entry is a line `ci` would replay that the classifier would not
  // accept, so ci would grade a comparison `verify` never ran.
  const recordedBase = [...baseKey];
  const record: PreexistingTierRecord = {
    cmd: opts.cmd,
    names: matched.slice(0, PREEXISTING_NAMES_CAP).map(boundedLine),
    total: matched.length,
    baseSha: opts.baseSha,
    ...(base.length <= PREEXISTING_BASE_NAMES_CAP &&
    recordedBase.every((line) => line.length <= PREEXISTING_NAME_MAX_CHARS)
      ? { baseNames: recordedBase }
      : {}),
  };
  // The record is about to be WRITTEN to the step log, and the log's own reader
  // (`preexistingFailuresProblem`, applied by `loadRun`) refuses a name longer than
  // `PREEXISTING_NAME_MAX_CHARS` or carrying a control character. `boundedLine` cut
  // every displayed line inside the bound and an over-long BASE line omitted `baseNames`
  // outright, so this asks the validator the question it will ask anyway rather than
  // persisting a record the run cannot be read back with: `saveRun` writes it and
  // `loadRun` then refuses the WHOLE run file.
  if (preexistingFailuresProblem({ [opts.tierName]: record }) !== undefined)
    return { kind: "refused" };
  return { kind: "excused", record };
}

/**
 * A head line cut to what the step log's reader accepts, for DISPLAY.
 *
 * `names` is the capped preview a human reads in the PR body and `total` carries the
 * true count; `baseNames` — the set `ci` replays — is never clipped at all (see
 * {@link baselineExcuse}). A whole failure line is far longer than
 * `PREEXISTING_NAME_MAX_CHARS` and the log's validator REFUSES an over-long entry, so
 * the clip happens here, where the excuse is still the caller's to forfeit, and never
 * at the reader.
 */
function boundedLine(line: string): string {
  return line.length > PREEXISTING_NAME_MAX_CHARS
    ? line.slice(0, PREEXISTING_NAME_MAX_CHARS)
    : line;
}

/**
 * The tail a green carries when a tier was excused over the base commit.
 *
 * `publish` prints the verify reason in the PR body's Verification section, so a
 * tier the gate let go names itself here as well as in the body's own
 * pre-existing-failures section: the prose is the warning, the recorded field is
 * the evidence the body renders from.
 */
export function preexistingReason(names: readonly string[]): string {
  return `pre-existing failures on the base commit: ${names.join(", ")} — every failing line also fails at the run's base commit, so no build round can fix them and this run did not author them`;
}

/**
 * A base run's stream rebuilt from lines that were read in another tree.
 *
 * `ci` reuses `verify`'s recorded base set rather than paying for its own probe, so
 * the lines it holds are the only evidence left of what the base printed. Each is
 * replayed VERBATIM: a recorded line is already the classifier's own accepted view of
 * a failure line, so it classifies again as itself and reads back through
 * {@link failureLinesOf} byte-for-byte — the same strings `verify` compared, which is
 * what lets `ci` grade a reuse on one tier run and no base probe. Wrapping a recorded
 * line in a runner's marker instead would need that marker removed on the way back in,
 * and the tree prefixes are already out of a recorded line, so nothing here moves.
 */
export function baseStreamOf(lines: readonly string[]): string {
  return lines.join("\n");
}
