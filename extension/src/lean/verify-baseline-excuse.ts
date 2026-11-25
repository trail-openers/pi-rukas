/**
 * lean/verify-baseline-excuse — a tier red at HEAD whose every failure line the base run
 * ALSO printed is not this run's failure.
 *
 * The unit of comparison is the WHOLE failure line, which keeps this runner-agnostic: a parser that reads a
 * test name out of each line folds two checks onto one token, and a folded name excuses a failure only this
 * run authored. Two checks are two lines, so whole lines cannot fold.
 *
 * The compared set is wider than the classifier — every non-empty line either run printed — so a head-only
 * line nobody recognised still has to appear at the base. The rule is DEFAULT-REFUSE in both directions of
 * ignorance: a line past {@link FAILURE_LINE_SCAN_MAX} refuses either side, and a head-only line refuses with
 * no allow-list of shapes that may be head-only. The accepted cost — a PR adding passing tests to a suite
 * already red at base, renumbered TAP output, a moved timing line — is a hand-back, never a green. Both
 * sides must be non-empty, every head line must equal a base line verbatim, the trees must be two trees,
 * and a base red shaped like a missing dependency tree is the probe's provisioning, not the commit's.
 * "Could not tell" is never an excuse: every refusal leaves the caller keeping the hand-back.
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
 * Does this stream hold a line past the classifier's scan window? Such a line is judged on its first 8 KiB,
 * so two differing only past the window fold onto one key — refuse on EITHER side.
 */
function hasOverWindowLine(stream: string): boolean {
  return splitLines(stream).some((line) => line.trim().length > FAILURE_LINE_SCAN_MAX);
}

/**
 * The lines the classifier READS as failures: stream order, trimmed, deduplicated, non-empty — the names
 * the `## Pre-existing` disclosure records, not the comparison set (`allLinesOf`).
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
 * The harness's OWN residue, discounted from the comparison.
 *
 * The executor prefixes its own `Command failed: <cmd>` echo to what the gate printed, so requiring
 * that writing at the base states nothing about the project's failures. It is the ONLY line discounted,
 * and by WHO WROTE it: admitted only when it quotes the command both runs were given.
 */
function harnessResidue(line: string, cmd: string, headRoot: string, probeRoot: string): boolean {
  if (!/^Command failed:\s/.test(line)) return false;
  const echoed = line.slice("Command failed:".length).trim();
  // One command is one command, whichever tree it ran from.
  const spellings = [cmd, stripRoot(cmd, headRoot), stripRoot(cmd, probeRoot)];
  return spellings.some(
    (c) => c === stripRoot(echoed, headRoot) || c === stripRoot(echoed, probeRoot),
  );
}

/**
 * Every line a stream printed that holds text, in stream order, trimmed and deduplicated: the comparison
 * set. Deliberately NOT `failureLines` — dropping an unread head-only line grades a defect the base never
 * printed as one it did.
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
 * The prefix is measured at the first character that could begin a path — `/`, `.` or a drive letter —
 * not column 0 where the runner's marker sits, and both spellings (with/without a trailing separator) are
 * tried. The search stops there: a root appearing later is content the tier printed, and a global removal
 * would erase a difference and excuse it.
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
 * A tree resolved to the spelling its own run would have printed it under: a tree reached through a
 * symlink prints its names under the symlinked spelling while the caller holds the resolved one. Only
 * the longest existing prefix resolves — the probe's tree is deleted before this comparison runs.
 */
function treeRoot(dir: string): string {
  const parts = dir
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  for (let i = parts.length; i >= 1; i--) {
    // Longest existing prefix; no hit is the answer for a path no part of which exists.
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
 * `worktree-provision`'s predicate reads its dependency phrases anywhere in the stream and a tier's own
 * `sh` trace can print them — so only an individually dependency-shaped FAILURE LINE counts.
 */
function baseRedIsMissingDeps(stream: string): boolean {
  return failureLines(stream).some((line) => MISSING_DEP_LINE.test(line));
}

/** A line the interpreter printed because the tree had no dependencies. */
const MISSING_DEP_LINE =
  /^\s*(?:sh|bash|zsh|npm|pnpm|yarn|bun|node|python\d*|pip\d*|go|cargo|make):\s|Cannot find module|ModuleNotFoundError|error: Cannot find package|command not found|Could not resolve\b/i;

/**
 * May this tier's red be excused over the base run's red?
 *
 * The caller settled the colour questions and the frozen acceptance verdict; this decides whether the head
 * run printed anything the base did not. Every refusal means the caller keeps the hand-back.
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
  // EVERY line each run printed, not only those the classifier recognises.
  const head = allLinesOf(headStream);
  const base = allLinesOf(baseStream);
  // A line past the classifier's window is judged on a clipped view.
  if (hasOverWindowLine(headStream) || hasOverWindowLine(baseStream)) return { kind: "refused" };
  // A probe tree that IS the run's own tree compares against nothing — every line is its own echo.
  const headRoot = treeRoot(opts.headRoot);
  const probeRoot = treeRoot(opts.probeRoot);
  if (headRoot === probeRoot) return { kind: "refused" };
  // A bare checkout whose dependencies were never linked fails every command: that red is the probe's
  // provisioning, not the commit's. Judged per FAILURE LINE, not anywhere in the stream.
  if (baseRedIsMissingDeps(baseStream)) return { kind: "refused" };
  // The RAW stream's lines, both sides: the residue discount runs after this, so a head left with nothing
  // but residue is refused here as an empty key set.
  if (head.length === 0 || base.length === 0) return { kind: "refused" };
  // One key per side: each line with ITS OWN tree's prefix out, keeping every digit — a moved pass count or
  // a renumbered TAP check hands the run back rather than granting a green.
  const residue = (line: string): boolean => harnessResidue(line, opts.cmd, headRoot, probeRoot);
  const headKey = head
    .map((line) => stripRoot(line, headRoot))
    .filter((line) => line.length > 0 && !residue(line));
  const baseKey = new Set(
    base.map((line) => stripRoot(line, probeRoot)).filter((line) => !residue(line)),
  );
  if (!headKey.every((line) => baseKey.has(line))) return { kind: "refused" };
  // The disclosure names only failures the classifier could read; the empty-set refusal above keeps it
  // naming real checks rather than none.
  const matched = failureLinesOf(headStream)
    .map((line) => stripRoot(line, headRoot))
    .filter((line) => line.length > 0);
  const record: PreexistingTierRecord = {
    cmd: opts.cmd,
    names: matched.slice(0, PREEXISTING_NAMES_CAP).map(boundedLine),
    total: matched.length,
    baseSha: opts.baseSha,
  };
  // The step log's reader refuses an over-long or control-character name and would then refuse the whole
  // run file — ask it here, while the refusal is cheap.
  if (preexistingFailuresProblem({ [opts.tierName]: record }) !== undefined)
    return { kind: "refused" };
  return { kind: "excused", record };
}

/**
 * A head line cut to what the step log's reader accepts, for DISPLAY only; `total` carries the true count.
 */
function boundedLine(line: string): string {
  return line.length > PREEXISTING_NAME_MAX_CHARS
    ? line.slice(0, PREEXISTING_NAME_MAX_CHARS)
    : line;
}

/**
 * The tail a green carries when a tier was excused over the base commit: what is KNOWN (every failing line
 * also fails at the base, which this run did not author) — not that a build round could not fix them,
 * which no gate measured.
 */
export function preexistingReason(names: readonly string[]): string {
  return `pre-existing failures on the base commit: ${names.join(", ")} — every failing line also fails at the run's base commit, which this run did not author them`;
}
