/**
 * spawn-child-bound — the per-child run bound of the child-supervision policy
 * (#1567 item 1, piece P3 / #1560).
 *
 * Nothing bounded a child short of the 2-h spawn backstop, so a develop and a
 * lens-fix child ran 86 and 84 minutes and stopped only when the caller's
 * deadline fell. The policy brings a per-child limit back, but only in this
 * shape:
 *
 *   1. at the bound, the child is steered to wrap up;
 *   2. `graceMs` (10 min) later it is ended, with kill cause `child-bound`;
 *   3. unless by then it has committed (HEAD in its cwd moved since spawn) or
 *      reported completion (its prompt's `agent_end` arrived): such a child is
 *      DONE, not killed — it is ended without a kill cause and its result
 *      counts as a completion (`DispatchResult.endedAsDone`).
 *
 * The kill never lands past the cycle deadline (cycle-deadline-clock.ts): when
 * the deadline comes before bound + grace, the deadline backstop in spawn.ts
 * does the kill and only the wrap-up steer is armed here, `graceMs` before it.
 * The work a killed child leaves stays in its worktree; every driver path that
 * resets a tree saves it first (#1391 / #1016).
 *
 * The same "done" test settles a child at the other two ends (#1521, P4):
 *
 *   - the 2-h backstop: a child that has committed or reported when it fires
 *     is ended as done, not as a `timeout` kill (`atBackstop`);
 *   - reaping: a child whose prompt's `agent_end` arrived (stdin closed) should
 *     exit by itself; one still alive `PI_ENSEMBLE_SETTLED_REAP_MS` (60 s)
 *     later is ended as done rather than left for the inactivity watchdog to
 *     kill as a hang 25 minutes on (`onReported`).
 *
 * The bound timers are armed only when a bound is passed; all of it is inert
 * under `PI_ENSEMBLE_DISPATCH_CAPS=0` (the caps master switch). One instance
 * per spawn.
 */

import { type ChildProcess, execFile } from "node:child_process";
import type { Writable } from "node:stream";
import { clampToCycleDeadline } from "./cycle-deadline-clock.ts";
import type { SteerSource } from "./dispatch-steer.ts";
import { killProcessTree } from "./spawn-kill.ts";
import { trace, traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

const MINUTE_MS = 60_000;

function envMs(key: string, fallbackMs: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

/** The develop child's bound (policy default 90 min). */
export function developChildBoundMs(): number {
  return envMs("PI_ENSEMBLE_DEVELOP_BOUND_MS", 90 * MINUTE_MS);
}

/** The explore child's bound (policy default 30 min). */
export function exploreChildBoundMs(): number {
  return envMs("PI_ENSEMBLE_EXPLORE_BOUND_MS", 30 * MINUTE_MS);
}

/** How long a child that reported may linger before it is reaped (60 s). */
export function settledReapMs(): number {
  return envMs("PI_ENSEMBLE_SETTLED_REAP_MS", 60_000);
}

/** Time between the wrap-up steer and the kill (policy: 10 min). */
export function childBoundGraceMs(): number {
  return envMs("PI_ENSEMBLE_CHILD_BOUND_GRACE_MS", 10 * MINUTE_MS);
}

/**
 * When the wrap-up steer and the kill land, in ms from now. `killAtMs` is
 * absent when the cycle deadline comes first: the deadline backstop kills.
 * `stopInMs` is how long the child has between the steer and the kill.
 */
export function childBoundSchedule(
  boundMs: number,
  graceMs: number,
  now: number,
): { wrapAtMs: number; killAtMs?: number; stopInMs: number } {
  const clamp = clampToCycleDeadline(boundMs + graceMs, now);
  if (!clamp.clamped) return { wrapAtMs: boundMs, killAtMs: boundMs + graceMs, stopInMs: graceMs };
  const wrapAtMs = Math.max(0, clamp.timeoutMs - graceMs);
  return { wrapAtMs, stopInMs: clamp.timeoutMs - wrapAtMs };
}

function wrapUpText(stopInMs: number): string {
  const min = Math.max(1, Math.round(stopInMs / MINUTE_MS));
  return `You have reached your time bound. Wrap up now: stop starting new work, commit what works, and send your final report. You will be stopped in ${min} minute(s).`;
}

/** Why a child at its bound counted as done rather than killed. */
export type DoneSignal = NonNullable<DispatchResult["endedAsDone"]>;

export interface ChildBound {
  /** The child was ended at its bound with nothing done (kill cause `child-bound`). */
  killed(): boolean;
  /** The child was ended at its bound after it had committed or reported. */
  endedAsDone(): DoneSignal | undefined;
  /** The bound the child was given, ms. */
  readonly boundMs: number;
  /**
   * The wall-clock backstop fired. Returns true when this took the kill over
   * (it ends the child as done if it has settled, else calls `timedOut` first);
   * false after calling `timedOut`, for the caller to kill as before.
   */
  atBackstop(timedOut: () => void): boolean;
  /** The prompt's `agent_end` arrived: reap the child if it does not exit. */
  onReported(): void;
  stop(): void;
}

/** HEAD of `cwd`, or undefined when it cannot be read. */
export function readHead(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 }, (err, stdout) => {
      const head = String(stdout ?? "").trim();
      resolve(err || !head ? undefined : head);
    });
  });
}

export function armChildBound(o: {
  child: ChildProcess;
  boundMs: number | undefined;
  cwd: string;
  /** The driver's steer seam; without one the steer is written to `stdin`. */
  onSteer?: (message: string, source: SteerSource) => void;
  stdin: Writable;
  /** The prompt's `agent_end` arrived (spawn.ts `promptCompleted`). */
  reported: () => boolean;
  childExited: () => boolean;
  /** Another kill (abort, the backstop) already ended the child: that cause stands. */
  preempted: () => boolean;
  /** False for a child that cannot commit (a read-only role, or one whose cwd is
   *  the shared repo root, where other cycles move HEAD): only `reported` is done. */
  commits: boolean;
  graceMs?: number;
  head?: (cwd: string) => Promise<string | undefined>;
}): ChildBound {
  const boundMs = o.boundMs ?? 0;
  let killed = false;
  let done: DoneSignal | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const result: ChildBound = {
    killed: () => killed,
    endedAsDone: () => done,
    boundMs,
    atBackstop: (timedOut) => {
      timedOut();
      return false;
    },
    onReported: () => undefined,
    stop: () => {
      for (const t of timers) clearTimeout(t);
    },
  };
  if (process.env.PI_ENSEMBLE_DISPATCH_CAPS === "0") return result;
  const head = o.head ?? readHead;
  const headAtStart = o.commits ? head(o.cwd) : Promise.resolve(undefined);
  // The exit event can lag the exit itself; read the handle too.
  const gone = () =>
    o.childExited() || o.child.exitCode != null || o.child.signalCode != null || o.preempted();
  const settled = async (): Promise<DoneSignal | undefined> => {
    if (o.reported()) return "reported";
    if (!o.commits) return undefined;
    const [before, now] = await Promise.all([headAtStart, head(o.cwd)]);
    return before && now && before !== now ? "committed" : undefined;
  };
  const kill = (why: string) => {
    trace(`child-bound: ${why}`);
    try {
      killProcessTree(o.child);
    } catch (err) {
      traceWarn(`child-bound kill failed: ${String(err)}`);
    }
  };
  const arm = (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref();
    timers.push(t);
  };
  result.onReported = () =>
    arm(() => {
      if (gone() || done || killed) return;
      done = "reported";
      kill("reaped a child that reported but did not exit");
    }, settledReapMs());
  result.atBackstop = (timedOut) => {
    if (!o.reported() && !o.commits) {
      timedOut();
      return false;
    }
    void settled().then((signal) => {
      if (gone() || done || killed) return;
      if (signal) done = signal;
      else timedOut();
      kill(`backstop fired (${signal ? `${signal}, ended as done` : "timeout"})`);
    });
    return true;
  };
  if (boundMs <= 0) return result;
  const graceMs = o.graceMs ?? childBoundGraceMs();
  const { wrapAtMs, killAtMs, stopInMs } = childBoundSchedule(boundMs, graceMs, Date.now());

  const wrapUp = () => {
    if (gone() || o.reported()) return;
    const message = wrapUpText(stopInMs);
    try {
      if (o.onSteer) o.onSteer(message, "driver-child-bound");
      else o.stdin.write(`${JSON.stringify({ type: "steer", message })}\n`);
    } catch {
      /* child already gone — the kill below still fires */
    }
  };
  const end = async () => {
    const signal = await settled();
    if (gone() || done || killed) return;
    if (signal) done = signal;
    else killed = true;
    kill(`ended at ${boundMs}ms bound + grace (${signal ?? "killed"})`);
  };
  arm(wrapUp, wrapAtMs);
  if (killAtMs !== undefined) arm(() => void end(), killAtMs);
  return result;
}

/**
 * Fold the bound's outcome into the result, after the cap attribution. The
 * policy ranks `child-bound` above the backstop's `timeout` and below every
 * structural cap, so it only replaces `timeout` / `abort` / no cause. A child
 * ended as done keeps no kill cause and counts as completed.
 */
export function applyChildBound(bound: ChildBound, result: DispatchResult): void {
  const cause = result.killCause;
  if (bound.killed() && (!cause || cause === "timeout" || cause === "abort")) {
    result.killCause = "child-bound";
    result.killBudgetMs = bound.boundMs;
    return;
  }
  const done = bound.endedAsDone();
  if (done && !cause) {
    result.endedAsDone = done;
    result.ok = !result.errorStop;
  }
}
