/**
 * work-develop-pass-record — the one place a finished develop pass becomes an
 * event and a verdict (#1768), extracted from `work-develop-run.ts` so the
 * dispatch closure keeps the size AGENTS.md §12 asks for.
 *
 * Three records, one decision, all keyed on the SAME verdict the tree produced:
 *
 *  - a crashed pass gets its `crash` record (#1403);
 *  - a pass that reported ok without committing its own work gets the
 *    `unfinished` record (#1768) — on EVERY plan size, because the incident was
 *    an N=1 cycle and suppressing the finding for N=1 is what made the shape
 *    invisible to every later reader (the park, the `/work-status` line, the
 *    handoff explanation and the corrective round all read this event, never
 *    the child's prose);
 *  - every other pass gets the ordinary `branch-completed`, only when the
 *    fan-out is multi-workstream (at N=1 the completion event already says it).
 *
 * The verdict list carries the same answer: an unfinished pass is marked
 * `noRetry`, because the #1016 fan-out retry calls `resetWorktreeToBase` before
 * re-dispatching — correct for the failures it handles, and it would discard the
 * very work the corrective round exists to finish.
 */

import type { ClassifyArgs, CrashVerdict, DevelopPassResult } from "./work-develop-crash.ts";
import { crashedBranchCompleted } from "./work-develop-crash.ts";
import type { ExecFn } from "./work-develop-git.ts";
import { driverCommitShasFor, unfinishedBranchCompleted } from "./work-develop-unfinished.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** What the caller's classify seam is given, so the driver's own commits reach
 *  the tree reading without the dispatch closure having to know where they
 *  live. */
export function classifyArgsForPass(args: {
  id: string;
  cwd: string;
  base: string | undefined;
  execFn: ExecFn;
  result: DevelopPassResult;
  stateRef: { current: WorkState };
}): ClassifyArgs {
  return {
    id: args.id,
    cwd: args.cwd,
    base: args.base,
    execFn: args.execFn,
    result: args.result,
    // #1768 — the driver's own recovery commits for this workstream, so the
    // green rule can never be satisfied by one of them. Read from the LIVE log at
    // classify time: a net commit created during THIS pass is already in it, and
    // a resumed cycle's log carries the earlier ones.
    driverShas: driverCommitShasFor(args.stateRef.current.eventLog, args.id),
  };
}

/** The completion record for a classified pass. `undefined` means the ordinary
 *  single-workstream case, where the caller's completion event already carries
 *  the outcome and a second record would be noise. */
export function passCompletedEvent(args: {
  id: string;
  ms: number;
  multi: boolean;
  verdict: CrashVerdict;
}): WorkEvent | undefined {
  if (args.verdict.crashed) {
    return crashedBranchCompleted({ id: args.id, ms: args.ms, verdict: args.verdict });
  }
  if (args.verdict.unfinished === true && args.verdict.unfinishedReading !== undefined) {
    return unfinishedBranchCompleted({
      id: args.id,
      ms: args.ms,
      reading: args.verdict.unfinishedReading,
    });
  }
  if (!args.multi) return undefined;
  return {
    kind: "branch-completed",
    step: "develop",
    workstreamId: args.id,
    ok: args.verdict.ok,
    ms: args.ms,
    at: Date.now(),
  };
}

/** The verdict entry for a classified pass: the reason on a failure, the
 *  commit attribution on a green, and `noRetry` on an unfinished pass. */
export function passVerdict(args: {
  id: string;
  verdict: CrashVerdict;
  tail: string | undefined;
}): {
  id: string;
  ok: boolean;
  reason?: string;
  noRetry?: true;
  ownCommits?: NonNullable<CrashVerdict["ownCommits"]>;
} {
  const { id, verdict, tail } = args;
  if (verdict.ok) {
    return { id, ok: true, ...(verdict.ownCommits ? { ownCommits: verdict.ownCommits } : {}) };
  }
  const reason = verdict.reason ?? tail ?? "developer did not complete ok";
  return {
    id,
    ok: false,
    reason,
    ...(verdict.unfinished === true ? { noRetry: true as const } : {}),
  };
}
