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
 * lines. Only when no worktree failed on its own does the consolidated run's
 * failure remain, and it is given to the one workstream of an N=1 cycle. With
 * N>1 no line can be attributed to one workstream, so the round declines. A
 * dependency signature on any evidence line declines the round, and the deps
 * hint stays (decision 1 of #1667).
 *
 * Eligibility reads the cap through `plainVerifyFailure` (and so `verifyCapFor`),
 * the one place that decides which failures are verify verdicts.
 */

import { plainVerifyFailure } from "./work-develop-verify-failure.ts";
import { isBuildResidueFailure } from "./work-driver-dirty-root-classify.ts";
import { isHostExhaustionFailure } from "./work-driver-exec-error.ts";
import { isVerifyTimeoutFailure } from "./work-driver-verify-develop-helpers.ts";
import { assertionLines } from "./work-driver-verify-record.ts";
import type { verifyStepOutcome } from "./work-driver-verify.ts";
import type { WorkEvent } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

/** Most assertion lines one workstream's developer is given. */
export const CORRECTIVE_MAX_LINES = 6;
/** Longest one assertion line is, in characters, before it is cut. */
export const CORRECTIVE_LINE_MAX = 300;

/** The develop verify gate's result, as the real type declares it. */
type DevelopGate = Awaited<ReturnType<typeof verifyStepOutcome>>;

/** The develop gate fields the decision reads: a view of the real gate type, never a copy. */
export type CorrectiveGateView = Pick<
  DevelopGate,
  "ok" | "failures" | "baselineRedOnly" | "buildResidueOnly" | "flakeRecovered" | "verifyRun"
>;

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
      /** Failing worktrees the round could not target, each with why. The caller traces them. */
      skipped: string[];
    };

/** The lines a developer is given for one workstream: bounded, each cut. */
function boundedLines(lines: readonly string[]): string[] {
  return lines
    .slice(0, CORRECTIVE_MAX_LINES)
    .map((l) => (l.length > CORRECTIVE_LINE_MAX ? `${l.slice(0, CORRECTIVE_LINE_MAX)}…` : l));
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
  const run = gate.verifyRun;
  if (run === undefined || run.status === "not-run") return no("no verify command ran");
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
    const skipped: string[] = [];
    for (const r of records) {
      const id = Object.keys(worktrees).find((k) => worktrees[k] === r.cwd);
      if (id === undefined) {
        skipped.push(`${r.cwd}: no workstream owns this worktree`);
        continue;
      }
      const lines = assertionLines(r.text);
      if (lines.length === 0) {
        skipped.push(`${id} (${r.cwd}): its failure carries no assertion line`);
        continue;
      }
      targets.push({ id, cwd: r.cwd, lines: boundedLines(lines) });
    }
    if (targets.length === 0) return no("the per-worktree failures carry no specific failing line");
    return { round: true, command: run.command, source: "per-workstream", targets, skipped };
  }

  // No worktree failed on its own: the consolidated run's failure is the only
  // evidence. One workstream owns it (N=1); with several, no workstream is
  // named by it, so the round declines rather than give every developer the
  // same lines.
  if (Object.keys(worktrees).length > 1)
    return no("the consolidated failure cannot be attributed to one of several workstreams");
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
  return { round: true, command: run.command, source: "consolidated", targets, skipped: [] };
}
