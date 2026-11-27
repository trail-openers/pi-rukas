/**
 * lib/lean-build-artifacts — what the fake child REPORTS and the clock the step reads.
 *
 * Split from `lib/lean-build-fixture.ts` for the 500-line gate (AGENTS.md §12), along the seam
 * that already exists there: the fixture BUILDS the repo and drives the step; these are the
 * per-dispatch OVERRIDE a case hands the fake child and the CLOCK it puts on the run, plus the two
 * exec wrappers the blocked gate's re-run needs. The bytes a child leaves in a tree are written by
 * `lean-build-git.ts`, the fixture family's bottom, which a case imports directly.
 */

import { type ExecResult, execp } from "../../src/exec.ts";
import type { BuildExec } from "../../src/lean/build-types.ts";
import type { DispatchResult } from "../../src/types.ts";
import { gitEnvFor } from "./lean-build-git.ts";

/**
 * What one dispatch of the fake child returns, per dispatch index: a list read
 * by index, or a rule called with it. `lib/lean-build-fixture.ts` puts it on
 * `RunOpts`; the override lives here so the fixture stays inside the size cap
 * while a case can still hand its dead child real fields.
 */
export type DispatchResultOverride =
  | Partial<DispatchResult>[]
  | ((n: number) => Partial<DispatchResult> | undefined);

/** The override for the nth child, or `undefined` when the case gave none. */
export function resultOverride(
  over: DispatchResultOverride | undefined,
  n: number,
): Partial<DispatchResult> | undefined {
  if (over === undefined) return undefined;
  return typeof over === "function" ? over(n) : over[n];
}

/**
 * The clock a case puts on the run record: the whole-cycle deadline (a fixed
 * epoch, or one read off the case's own clock) and the `now` the step is told to
 * use. Both absent is today's shape — no deadline, a fixed clock — which is what
 * every case that says nothing about the deadline expects.
 *
 * A bounded-wait case needs both: the wait-take and the wait-skip branch differ
 * only in what `deadline − now` leaves, and a fixture frozen at one reading can
 * drive neither. Such a case pins `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` so the
 * allowance it compares against is its own, not the shipped one.
 */
export interface ClockOpts {
  deadlineMs?: number | ((now: number) => number | undefined);
  now?: () => number;
}

/** The absolute deadline to stamp on the run, or `undefined` for none. */
export function deadlineOf(clock: ClockOpts | undefined, now: () => number): number | undefined {
  const d = clock?.deadlineMs;
  if (d === undefined) return undefined;
  return typeof d === "number" ? d : d(now());
}

/**
 * A stand-in runner for the driver's re-run of a reported frozen test: called
 * INSTEAD of the real `execp` for a non-git command issued after the child
 * returned — which is exactly when the blocked gate re-runs the named files.
 * git keeps going to the real binary and is recorded in `gitArgvs`, so a case
 * about the step's normalisation and commit path is untouched by a bad-runner
 * case.
 */
export function reRunStub(
  stub: ((cmd: string, o?: unknown) => Promise<unknown>) | undefined,
  dispatched: () => number,
  gitArgvs: string[][],
): BuildExec {
  return async (cmd, o) => {
    if (cmd === "git" && o?.argv) gitArgvs.push(o.argv);
    if (stub !== undefined && cmd !== "git" && dispatched() > 0)
      return (await stub(cmd, o)) as ExecResult;
    return execp(cmd, { ...o, env: gitEnvFor() });
  };
}

/**
 * Watches every exec WITHOUT replacing it: the real runner still runs,
 * so a case can read what the driver handed it (an env, a timeout) while the
 * runner's verdict stays the real one. `reRunStub`'s stub REPLACES the runner,
 * which is the wrong shape for an assertion about the arguments. A spy that
 * throws is a call that rejected with no exit code, before git ever ran.
 */
export function execObserver(
  inner: BuildExec,
  spy: ((cmd: string, o?: unknown) => void) | undefined,
): BuildExec {
  return async (cmd, o) => {
    spy?.(cmd, o);
    return inner(cmd, o);
  };
}
