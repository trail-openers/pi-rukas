/**
 * lean/verify-baseline-excuse — a tier red at HEAD whose every failure the base
 * run ALSO printed is not this run's failure.
 *
 * `verify-baseline.ts` asks whether the base is red at all and hands the run back when
 * it is. That answer is correct but expensive: a mainline whose own suite is red on this
 * host hands back every run of a perfectly good change, and a build round could not fix
 * a gate the base authored. This module asks the narrower question — WHICH lines did each
 * run print as failing — and answers "grade it green, and say so" when the head run
 * printed nothing the base run did not print.
 *
 * The unit of comparison is the WHOLE failure line, which is what makes it runner-agnostic.
 * A parser that reads a test name out of each line always finds a way to fold two different
 * checks onto one token, and a folded name excuses a failure only this run authored — the one
 * thing this feature must never do. Whole lines cannot fold: two checks are two lines, and
 * two runs of ONE check print the SAME line.
 *
 * It is deliberately stricter than "the base was red too". The unit of comparison is the
 * whole line; the SCANE set is wider than the classifier:
 *
 *   - the excuse compares EVERY line either run printed, not only the lines the shared
 *     classifier reads. A line it recognises is a failure it can NAME, and those are the
 *     lines the disclosure records — pytest, TAP/bats, go, a script tally, a `FAIL`
 *     header, the driver's own diagnostic dialect. A line it does not read is still text
 *     the head printed, and a head-only one of those is a defect nobody read: a bare
 *     `killed`, an `Exit code: 1`, a jest `●` block, a `# not ok 9` TAP comment, a
 *     zero-width character inside a name. All refuse. Only the executor's own writing —
 *     {@link harnessResidue} — is discounted, and only for who wrote it;
 *   - one rule decides what the excuse may not see, and it REFUSES rather than omitting,
 *     in BOTH directions of ignorance. A line past {@link FAILURE_LINE_SCAN_MAX} refuses
 *     either side, because a judge that saw only its first 8 KiB cannot tell two long
 *     lines apart. And a HEAD-ONLY line refuses, full stop: there is no list of shapes
 *     that may be head-only. That is DEFAULT-REFUSE, and it is the whole design — a
 *     classifier's table is only what its authors thought to read, so omitting everything
 *     outside it would let a head of `[readable A, unread B]` match a base that printed
 *     only A. The accepted cost: a PR that ADDS PASSING TESTS to a suite already red at
 *     base hands back (its `1 failed, 5 passed` summary is head-only), so do renumbered
 *     TAP output and any timing line whose text moved. Each is a hand-back, not a green;
 *   - both sets must be non-empty and EVERY head line must equal a base line VERBATIM —
 *     trimmed, its own tree's prefix out, nothing else folded. A changed reason, a moved
 *     counter or a shifted check index is a different line;
 *   - the two trees must still be two trees. Compared in one tree every line is its
 *     own echo and the comparison proves nothing about which run printed what;
 *   - a base run whose red looks like a missing dependency tree is not evidence
 *     the commit is red, it is evidence the probe was not provisioned.
 *
 * "Could not tell" is never an excuse, and the caller falls back to exactly the
 * hand-back `verify-baseline.ts` produced before this module existed.
 *
 * What used to sit beside this rule — an allow-list of head-only shapes, a fold over a
 * runner's counters, harness and passing-check exemptions, a failure veto, the scrubbing
 * they read through, and a comparison scoped to the classifier's own lines — is gone:
 * exceptions granted one adversarial pass at a time, none of which ever excused a run in
 * the field. What is left fails only toward the hand-back.
 */

import { realpathSync } from "node:fs";
import { FAILURE_LINE_SCAN_MAX, failureLines } from "../work-driver-verify-failures.ts";
import { splitLines } from "../work-driver-verify-support.ts";
import {
  PREEXISTING_NAMES_CAP,
  PREEXISTING_NAME_MAX_CHARS,
  type PreexistingTierRecord,
  preexistingFailuresProblem,
} from "./state-outcome-maps.ts";
import type { BaseProbe } from "./verify-baseline.ts";

/** Why the base red cannot excuse this tier's red. */
export type BaselineExcuse =
  | { kind: "excused"; record: PreexistingTierRecord }
  | { kind: "refused" };

/**
 * Does this stream hold a line past the classifier's scan window?
 *
 * The classifier decides such a line on its first 8 KiB, so two lines differing only
 * past the window answer the same and can fold onto one comparison key — the folding
 * this whole module exists to prevent, arriving through length instead of through a
 * token parser. A line no judge fully saw is not evidence, so it refuses on EITHER side
 * — and it asks the RAW stream lines, not `failureLines`' output: the line that carries
 * the defect may be one the classifier never reads, and a window check over only the
 * lines it read would stay silent for exactly that stream.
 */
function hasOverWindowLine(stream: string): boolean {
  return splitLines(stream).some((line) => line.trim().length > FAILURE_LINE_SCAN_MAX);
}

/**
 * The lines of this stream the classifier READS as failures: stream order, trimmed,
 * deduplicated, non-empty — the names the `## Pre-existing` disclosure records. A
 * runner repeats a summary line, and a set that counted the repeat would report a
 * failing count the tier did not have.
 *
 * NOT the set the excuse is compared on — that is {@link allLinesOf}, every non-empty
 * line read or not, so a head line the classifier does not recognise still has to appear
 * at the base.
 */
export function failureLinesOf(stream: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of failureLines(stream)) {
    const key = line.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * The harness's OWN per-run residue, discounted from the comparison, and the one echo
 * that may stand in for a base line.
 *
 * The streams the excuse reads are BUILT by the executor, which stamps its own writing
 * beside what the gate printed: a `tier-said-<marker>-<n>` trace line, a
 * `boom from the <tier>` line, and a `Command failed: <cmd>` echo. None came from the
 * project and no two runs of ONE tier print them identically — the re-run's stamp carries
 * its run number — so requiring a line the EXECUTOR wrote to appear at the base is not a
 * requirement about the project's failures at all: it refuses every real tier in the
 * suite.
 *
 * The discount is by WHO WROTE the line, never by what it says, and it is anchored to the
 * harness's whole-line forms: a gate line that merely OPENS with `killed` keeps its text,
 * and the echo is admitted only when it quotes the command both runs were given (either
 * tree's prefix out of it), so a failure spelled inside the quoted command does not ride
 * in on the prefix. A bare `killed`, `Exit code: 1`, a jest `●` block, a `# not ok 9` TAP
 * comment and a zero-width character inside a name are all refused.
 */
function harnessResidue(line: string, cmd: string, headRoot: string, probeRoot: string): boolean {
  if (/^tier-said-[A-Za-z0-9_-]+(?:-\d+)?$/.test(line)) return true;
  if (/^boom from the [A-Za-z0-9_ -]+$/.test(line)) return true;
  if (!/^Command failed:\s/.test(line)) return false;
  const echoed = line.slice("Command failed:".length).trim();
  // One command is one command, whichever tree it was run from.
  const spellings = [cmd, stripRoot(cmd, headRoot), stripRoot(cmd, probeRoot)];
  return spellings.some(
    (c) => c === stripRoot(echoed, headRoot) || c === stripRoot(echoed, probeRoot),
  );
}

/**
 * Every line a stream printed that holds text, in stream order, trimmed and deduplicated:
 * the comparison set for both sides.
 *
 * Deliberately NOT `failureLines`. The classifier answers what a failure LOOKS like, and
 * its table is a list of what its authors read, so an unread head-only line — `killed`,
 * `Exit code: 1`, a jest `●` block, a TAP comment — dropped from the comparison is a
 * defect the base never printed graded as one it did. A repeated line is one line.
 */
function allLinesOf(stream: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of splitLines(stream)) {
    const line = raw.trim();
    if (line.length === 0 || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
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
 * Exported because {@link baselineExcuse} builds both sides' comparison keys with it,
 * and the two sides of the seam must normalise a path the same way or a line differs by
 * its tree alone.
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
 * whether the head run printed anything the base did not — over EVERY line of both
 * streams, the classifier's own lines and the ones it cannot read alike. Every
 * refusal means the caller keeps the hand-back `verify-baseline.ts` produced before
 * this module.
 *
 * `cmd` is the record's label, and it is matched against ONE thing: the command quoted
 * in the executor's `Command failed:` echo, which {@link harnessResidue} discounts only
 * when it names the command both runs were given. No other head-only line is vouched for.
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
  // EVERY line each run printed, not the lines the classifier recognises: an unread
  // head-only line is a defect nothing read, and nothing read is nothing excused.
  const head = allLinesOf(headStream);
  const base = allLinesOf(baseStream);
  // A line either stream printed past the classifier's window is judged on a clipped
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
  // A head-only line excuses nothing: the comparison below refuses it, because no fold,
  // allow-list or harness exemption is left to place a line the base did not print —
  // except the executor's own writing, which {@link harnessResidue} answers for.
  if (head.length === 0 || base.length === 0) return { kind: "refused" };
  // The text two runs' lines are compared as: each side with ITS OWN tree's prefix out of
  // it, so head and base agree on what the check WAS, not on where each run ran. ONE key,
  // and it keeps every digit: `expected 3 to be 4` and `expected 3 to be 5` are two defects,
  // a runner summary whose pass count moved is a head-only line, and a renumbered TAP check
  // is a different line. Each of those hands the run back — never a green.
  // One key per side: each line with ITS OWN tree's prefix out, so head and base agree on
  // what the check WAS, not on where each run ran. It keeps every digit — `expected 3 to be
  // 4` and `expected 3 to be 5` are two defects, a moved pass count is a head-only line, and
  // a renumbered TAP check is a different line. Each hands the run back, never a green.
  const residue = (line: string): boolean => harnessResidue(line, opts.cmd, headRoot, probeRoot);
  const headKey = head
    .map((line) => stripRoot(line, headRoot))
    .filter((line) => line.length > 0 && !residue(line));
  const baseKey = new Set(
    base.map((line) => stripRoot(line, probeRoot)).filter((line) => !residue(line)),
  );
  if (!headKey.every((line) => baseKey.has(line))) return { kind: "refused" };
  // The disclosure names only the failures the classifier could read: a head line it
  // cannot read was refused above, so what reaches the PR body is failing checks, never
  // a stream's prose.
  const matched = failureLinesOf(headStream)
    .map((line) => stripRoot(line, headRoot))
    .filter((line) => line.length > 0);
  // The comparison ran on the COMPLETE parsed sets; the caps below bound only what is
  // persisted and rendered. A line past the log's own bound would be refused by its reader
  // below, so nothing here truncates a set the caller compared.
  const record: PreexistingTierRecord = {
    cmd: opts.cmd,
    names: matched.slice(0, PREEXISTING_NAMES_CAP).map(boundedLine),
    total: matched.length,
    baseSha: opts.baseSha,
  };
  // The record is about to be WRITTEN to the step log, and the log's own reader
  // (`preexistingFailuresProblem`, applied by `loadRun`) refuses a name longer than
  // `PREEXISTING_NAME_MAX_CHARS` or carrying a control character. `boundedLine` cut every
  // displayed line inside the bound, so this asks the validator the question it will ask
  // anyway rather than persisting a record the run cannot be read back with: `saveRun`
  // writes it and `loadRun` then refuses the WHOLE run file.
  if (preexistingFailuresProblem({ [opts.tierName]: record }) !== undefined)
    return { kind: "refused" };
  return { kind: "excused", record };
}

/**
 * A head line cut to what the step log's reader accepts, for DISPLAY.
 *
 * `names` is the capped preview a human reads in the PR body and `total` carries the
 * true count. A whole failure line is far longer than
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
