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
 * runner-agnostic. The parser this module replaced read pytest's `path::name` out
 * of each line and compared tokens; every parser tried for a TAP description or a
 * go test name found a new way to fold two different checks onto one token, and a
 * folded name excuses a failure only this run authored — the one thing this feature
 * must never do. Whole lines cannot fold: two checks are two lines, and two runs of
 * ONE check print the SAME line.
 *
 * It is deliberately stricter than "the base was red too":
 *
 *   - lines come from `failureLines` / `classifyFailureLine`, so the excusable set
 *     is exactly the shapes the shared classifier recognises — pytest, TAP/bats, go,
 *     a script tally, a `FAIL` header, the driver's own diagnostic dialect. A runner
 *     outside that table prints nothing the excuse can read, names nothing, and
 *     excuses nothing;
 *   - the compared text is the classifier's own accepted view of a line — its
 *     trimmed text, judged through the same 8 KiB scan window the table used — with
 *     both worktree roots stripped as literal prefixes. A pair equal only past the
 *     window is a pair no judge saw, so a stream whose only failing line sits beyond
 *     the window names nothing and excuses nothing;
 *   - a line whose trimmed text starts with `FAILED ` or `ERROR ` is a runner declaring
 *     a failing test, so it must be recognised even where the classifier answers
 *     nothing: `ERROR tests/x.py` (a collection error) and a bare `FAILED tests/y.py`
 *     excuse nothing — dropping one grades a tier green on a failure the base never
 *     printed;
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
  harnessInnerLine,
} from "../work-driver-verify-failures.ts";
import {
  PREEXISTING_BASE_NAMES_CAP,
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

/** A runner opening its own line with a failing test — pytest's word for one. */
const DECLARED_FAILURE = /^(?:FAILED|ERROR)\s/;

/**
 * One candidate line clipped to the scan window BEFORE anything reads it.
 *
 * The same bound `work-driver-verify-full.ts`'s `clipForScanSlice` applies to a
 * packed slice: a pathological line costs the window and no more, in the classifier
 * and in this module's own marker test alike.
 */
function clipForScan(line: string): string {
  return line.length > FAILURE_LINE_SCAN_MAX ? line.slice(0, FAILURE_LINE_SCAN_MAX) : line;
}

/**
 * Is any line of this stream a failing test the shared classifier does not name?
 *
 * A runner this module cannot classify — a bare `error:`, a `FAILED tests/y.py` with
 * no `::`, a tally in a dialect the table does not carry — still exits non-zero, and
 * excusing a tier that printed such a line beside its recognised ones would wave the
 * unread failures through with the read ones. So one such line refuses the WHOLE
 * excuse, on either stream, rather than going uncounted.
 *
 * The marker test is asked of every raw line: `failureLines` classifies first, so an
 * unrecognised `FAILED …` / `ERROR …` never reaches its output and only this walk
 * sees it.
 */
function hasUnreadableFailureLine(stream: string): boolean {
  for (const line of stream.split(/\r\n|\r|\n/)) {
    if (classifyFailureLine(clipForScan(line)) !== undefined) continue;
    if (DECLARED_FAILURE.test(line.trim())) return true;
  }
  return false;
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
 * "What it accepted" is the classifier's own view, obtained by asking its questions
 * in its own order — {@link harnessInnerLine} behind a harness wrapper, otherwise the
 * trimmed line, each as its table judged it inside the 8 KiB scan window. That is what
 * makes the recorded set replayable: {@link baseStreamOf} writes a recorded line back
 * unchanged, and a line the classifier accepted the first time accepts again, so `ci`
 * compares byte-for-byte the strings `verify` compared.
 *
 * `undefined` for a line the classifier does not recognise — the same veto
 * {@link failureLinesOf} applies, asked here so a caller cannot hand an unread line
 * to the comparison.
 */
function comparableLine(line: string): string | undefined {
  // The UNCLIPPED line goes to the classifier: its own `scanWindow` is the single
  // bound it documents, and it decides a harness wrapper's end over the whole line
  // before clipping the gate's text. Clipping here first would be a second window in
  // front of the one judge, and a wrapper whose command string runs past it would be
  // judged as prose.
  if (classifyFailureLine(line) === undefined) return undefined;
  // The classifier ACCEPTED the line, so its own cut — not the caller's raw text — is
  // what a reader is shown for a harness-wrapped failure. Asked only on a line the
  // table already read, so the two readers cannot disagree about what the gate printed.
  const accepted = harnessInnerLine(line) ?? line.trim();
  return accepted.length === 0 ? undefined : accepted;
}

/**
 * One run's tree prefix, out of a line.
 *
 * Asked as LITERAL prefixes, not as a path split: a TAP or a go line has no `::` to
 * split on, and `checkout - expected 3 got 4` has no path at all. Both spellings are
 * removed — with and without a trailing separator — so a runner that printed
 * `<root>/t/x.t` gives up its tree's text and keeps `t/x.t`, which is what a run in
 * the OTHER tree prints for the same check.
 */
function stripRoot(line: string, root: string): string {
  const resolved = root.trim();
  if (resolved.length === 0) return line;
  let out = line;
  for (const spelling of [resolved, resolved.replace(/\/$/, "")]) {
    if (spelling.length > 0) out = out.split(spelling).join("");
  }
  return out.trim();
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
  const head = failureLinesOf(opts.headStream ?? "");
  const base = failureLinesOf(baseStream);
  // A bare checkout whose dependencies were never linked fails every command: that
  // red belongs to the probe's provisioning, not to the commit, and no line it
  // prints can stand as evidence the base was red.
  if (baseRedIsMissingDeps(baseStream)) return { kind: "refused" };
  // Every failing test either stream declares must be one the classifier names.
  if (hasUnreadableFailureLine(opts.headStream ?? "")) return { kind: "refused" };
  if (hasUnreadableFailureLine(baseStream)) return { kind: "refused" };
  if (head.length === 0 || base.length === 0) return { kind: "refused" };
  // Both trees resolved ONCE for this comparison, and a probe tree that is the run's
  // own tree — or another spelling of it — compares against nothing: every line is
  // its own echo.
  const headRoot = treeRoot(opts.headRoot);
  const probeRoot = treeRoot(opts.probeRoot);
  if (headRoot === probeRoot) return { kind: "refused" };
  // The text two runs' lines are compared as: each side with ITS OWN tree's prefix out
  // of it, so head and base agree on what the check was, not on where each run ran.
  const headKey = head.map((line) => stripRoot(line, headRoot));
  const baseKey = new Set(base.map((line) => stripRoot(line, probeRoot)));
  if (!headKey.every((line) => line.length > 0 && baseKey.has(line))) return { kind: "refused" };
  const matched = headKey.filter((line) => line.length > 0);
  // The comparison ran on the COMPLETE parsed sets; the caps below bound only what
  // is persisted and rendered. `baseNames` is what lets `ci` reuse this record
  // instead of paying for its own base probe, and an oversized one is omitted
  // rather than truncated: a partial base set would make ci's comparison a lie.
  const record: PreexistingTierRecord = {
    cmd: opts.cmd,
    names: matched.slice(0, PREEXISTING_NAMES_CAP).map(boundedLine),
    total: matched.length,
    baseSha: opts.baseSha,
    ...(base.length <= PREEXISTING_BASE_NAMES_CAP
      ? { baseNames: [...baseKey].map(boundedLine) }
      : {}),
  };
  // The record is about to be WRITTEN to the step log, and the log's own reader
  // (`preexistingFailuresProblem`, applied by `loadRun`) refuses a name longer than
  // `PREEXISTING_NAME_MAX_CHARS` or carrying a control character — which the 8 KiB
  // scan-window clip can produce on its own, by cutting a line in the middle of an
  // astral character. `boundedLine` already cut every line inside the bound and on a
  // character boundary, so this asks the validator the question it will ask anyway
  // rather than persisting a record the run cannot be read back with: `saveRun`
  // writes it and `loadRun` then refuses the WHOLE run file.
  if (preexistingFailuresProblem({ [opts.tierName]: record }) !== undefined)
    return { kind: "refused" };
  return { kind: "excused", record };
}

/**
 * A comparable line cut to what the step log's reader accepts, on a character
 * boundary.
 *
 * A whole failure line is far longer than `PREEXISTING_NAME_MAX_CHARS`, and the log's
 * validator REFUSES an over-long entry rather than clipping it — so the clip happens
 * here, where the excuse is still the caller's to forfeit, and never at the reader.
 * The cut steps back over a trailing high surrogate so it cannot leave the lone half
 * of an astral character behind, which `\p{Cc}` would refuse for the same reason.
 */
function boundedLine(line: string): string {
  const cut =
    line.length > PREEXISTING_NAME_MAX_CHARS ? line.slice(0, PREEXISTING_NAME_MAX_CHARS) : line;
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return cut.slice(0, -1);
  return cut;
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
