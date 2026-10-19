/**
 * work-driver-corrective-decide — #1667: whether a failed develop verify earns
 * the cycle's ONE corrective round, and which workstreams it is given to.
 *
 * Pure: it reads the develop gate's result and the event log, and returns a
 * decision. No git, no dispatch, no state write. The round itself lives in
 * work-driver-corrective-round.ts.
 *
 * The trigger is a plain verify-failed:develop whose failures are all verify
 * command output, with at least one assertion line a developer can act on.
 * Attribution: a workstream whose OWN worktree verify failed gets its own
 * lines; only when no worktree failure exists is the consolidated run's
 * failure given to every workstream. A dependency signature on any evidence
 * line declines the round, and the deps hint stays (decision 1 of #1667).
 */

import { plainVerifyFailure } from "./work-develop-verify-failure.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "./work-driver-consolidation-classify.ts";
import { isBuildResidueFailure } from "./work-driver-dirty-root-classify.ts";
import { isHostExhaustionFailure } from "./work-driver-exec-error.ts";
import { isVerifyTimeoutFailure } from "./work-driver-verify-develop-helpers.ts";
import type { WorkEvent } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

/** Most assertion lines one workstream's developer is given. */
export const CORRECTIVE_MAX_LINES = 6;
/** Longest one assertion line is, in characters, before it is cut. */
export const CORRECTIVE_LINE_MAX = 300;

/**
 * What the verify command gate recorded about its own run, so the decision can
 * tell verify output from every other gate's failure. Filled by the verify
 * command block (work-driver-verify-develop-command.ts) and returned on the
 * gate result.
 */
export interface VerifyCommandRecord {
  /** The verify command the gate ran (absent when no command ran). */
  command?: string;
  /** Every failure the verify command gate itself appended, in order. */
  failures: string[];
  /** One entry per worktree whose own verify run failed: its cwd and failure text. */
  perWorktree: Array<{ cwd: string; text: string }>;
  /** The consolidated run's raw failure stream, when that run failed. */
  consolidatedRaw?: string;
}

/** The develop gate fields the decision reads. */
export interface CorrectiveGateView {
  ok: boolean;
  failures: string[];
  baselineRedOnly?: boolean;
  buildResidueOnly?: boolean;
  flakeRecovered?: boolean;
  verifyRun?: VerifyCommandRecord;
}

/** One workstream the round dispatches, with the only lines its developer gets. */
export interface CorrectiveTarget {
  id: string;
  cwd: string;
  lines: string[];
}

export type CorrectiveDecision =
  | { round: false; reason: string }
  | {
      round: true;
      command: string;
      source: "per-workstream" | "consolidated";
      targets: CorrectiveTarget[];
    };

/**
 * Every line of `text` a developer can act on: the lines the extractor accepts
 * as an assertion (a `✗` line, a compiler or linter error). Uncapped — the
 * dependency check must read every line, not the bounded subset given out.
 */
export function assertionLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || seen.has(line)) continue;
    if (extractSpecificAssertion(line) === NO_SPECIFIC_ASSERTION) continue;
    seen.add(line);
    out.push(line);
  }
  // A `✗` line is the assertion the operator named; when there is one, the
  // generic error lines around it are noise, not a second diagnosis.
  const marked = out.filter((l) => l.startsWith("\u2717"));
  return marked.length > 0 ? marked : out;
}

/** The lines a developer is given for one workstream: bounded, each cut. */
function boundedLines(lines: readonly string[]): string[] {
  return lines
    .slice(0, CORRECTIVE_MAX_LINES)
    .map((l) => (l.length > CORRECTIVE_LINE_MAX ? `${l.slice(0, CORRECTIVE_LINE_MAX)}…` : l));
}

/**
 * #1667 — the deps hint the per-worktree verify appends. Suppressed whenever
 * assertion lines were extracted: the hint then names a cause the output does
 * not support. The exception is a dependency signature ON an extracted line —
 * that line is the diagnosis, and the hint stays with it.
 */
export function depsHintApplies(output: string): boolean {
  const lines = assertionLines(output);
  return lines.length === 0 ? looksLikeMissingDeps(output) : lines.some(looksLikeMissingDeps);
}

/**
 * Decide whether the failed develop verify earns the one corrective round.
 *
 * `worktrees` is the state's map with the develop step's own fallback applied
 * (`{ default: repoRoot }` for N=1 without one), so attribution reads the same
 * tree the verify gate ran in.
 */
export function decideCorrectiveRound(
  gate: CorrectiveGateView,
  input: { eventLog: readonly WorkEvent[]; worktrees: Record<string, string> },
): CorrectiveDecision {
  const no = (reason: string): CorrectiveDecision => ({ round: false, reason });
  if (gate.ok) return no("the develop gate passed");
  if (gate.flakeRecovered === true) return no("the verify flake recovered on re-run");
  if (input.eventLog.some((e) => e.kind === "corrective-round"))
    return no("the cycle's one corrective round already ran");
  if (gate.baselineRedOnly === true) return no("the verify command is red at base");
  if (gate.buildResidueOnly === true) return no("the gate declined on build residue");
  const run = gate.verifyRun;
  if (run?.command === undefined) return no("no verify command ran");
  if (!plainVerifyFailure(gate)) return no("the cap is not verify-failed:develop");
  // Every failure must be verify command output: a scope, protected-path or
  // ratchet failure is not something this developer's lines can repair.
  if (gate.failures.some((f) => !run.failures.includes(f)))
    return no("a failure outside the verify command (scope, protected path, ratchet) is recorded");
  // A run that reached no verdict gets no round, even beside a real failure.
  if (
    gate.failures.some(
      (f) => isVerifyTimeoutFailure(f) || isHostExhaustionFailure(f) || isBuildResidueFailure(f),
    )
  )
    return no("a run killed at its bound or refused by the host reached no verdict");

  const worktrees = input.worktrees;
  const records = run.perWorktree;
  if (records.length > 0) {
    // Every assertion line the round would show, checked for the dependency signature.
    const all = records.flatMap((r) => assertionLines(r.text));
    if (all.some(looksLikeMissingDeps))
      return no("an evidence line names a missing dependency; the deps hint stays");
    const targets: CorrectiveTarget[] = [];
    for (const r of records) {
      const id = Object.keys(worktrees).find((k) => worktrees[k] === r.cwd);
      const lines = assertionLines(r.text);
      if (id === undefined || lines.length === 0) continue;
      targets.push({ id, cwd: r.cwd, lines: boundedLines(lines) });
    }
    if (targets.length === 0) return no("the per-worktree failures carry no specific failing line");
    return {
      round: true,
      command: run.command,
      source: "per-workstream",
      targets,
    };
  }

  // No worktree failed on its own: the consolidated run's failure is the only
  // evidence, and every workstream is given it.
  const lines = assertionLines(run.consolidatedRaw ?? "");
  if (lines.some(looksLikeMissingDeps))
    return no("an evidence line names a missing dependency; the deps hint stays");
  if (lines.length === 0) return no("the consolidated failure carries no specific failing line");
  const bounded = boundedLines(lines);
  const targets = Object.entries(worktrees).map(([id, cwd]) => ({
    id,
    cwd,
    lines: bounded,
  }));
  return { round: true, command: run.command, source: "consolidated", targets };
}
