/**
 * spawn-supervision — the two spawn-level timers that KILL and are owned by
 * neither the caps session nor the per-child bound, extracted from `spawn.ts`
 * for the AGENTS.md §12 size cap.
 *
 * What ends a child from outside is spread over four modules by WHO owns the
 * budget, and this one holds the two that are neither structural caps
 * (`spawn-caps.ts`) nor the run bound (`spawn-child-bound.ts`): the caller's
 * wall-clock backstop and Pi's user-cancel. The inactivity/tool-inactivity poll
 * is a third reason and lives in `spawn-inflight.ts`, watching stdout rather
 * than a fixed budget.
 *
 * They are one module because they are one idea: each is a timer armed for the
 * child's lifetime that ends it from outside the normal flow, and each must
 * therefore (a) run its kill on its OWN `setTimeout`/listener so a throw
 * escaping it is not an uncaught exception at timer level that would take down
 * the parent and every sibling child (the #1510 lesson), (b) record its cause
 * on the kill flags BEFORE attempting the signal, so the report still names the
 * budget that expired when `killProcessTree` cannot land, and (c) hand back the
 * detach the spawn's `finally` block runs, so no timer outlives the child.
 *
 * Nothing here decides policy: which budget is configured, what a kill means
 * for the result, and the order the causes are resolved in all belong to
 * `spawn-caps.ts` / `spawn-watchdog.ts`. These three are the timers only, and
 * they deliberately do NOT consult `boundArmed` — unlike the reviewer bounds, a
 * wall-clock or abort kill is never advisory, so a bound that armed earlier
 * does not stand these down (whoever set its cause first is what
 * `resolveKillCause` reports).
 */

import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "./spawn-kill.ts";
import { traceWarn } from "./trace.ts";

/** A guarded `killProcessTree`: a child already gone, or a group we lost the
 * handle to, is never an error that escapes a timer. */
function guardedKill(child: ChildProcess, what: string): void {
  try {
    killProcessTree(child);
  } catch (err) {
    traceWarn(`${what} killProcessTree failed: ${String(err)}`);
  }
}

/**
 * The wall-clock backstop (#1510 sibling of `createInactivityPoll`). It catches
 * a child that keeps producing events forever; the inactivity watchdog detects
 * true hangs without a view on how fast the child's model happens to be.
 *
 * `onTimeout` returns true when the caller took the kill over itself (#1521: a
 * child that committed or reported is ended as done instead of killed). The
 * caller sets `timedOut` first, so `killCause()` reports "timeout" even when
 * the signal cannot land.
 */
export function createWallClockBackstop(opts: {
  child: ChildProcess;
  timeoutMs: number;
  onTimeout: () => boolean | undefined;
}): () => void {
  const { child, timeoutMs, onTimeout } = opts;
  const timeout = setTimeout(() => {
    if (onTimeout() === true) return;
    guardedKill(child, "wall-clock backstop");
  }, timeoutMs);
  return () => clearTimeout(timeout);
}

/**
 * Propagate Pi's user-cancel (Esc) signal: kill the child so the tool-execute
 * promise resolves and Pi un-sticks immediately (#1510 sibling of the two timer
 * kills). Fires once, immediately if the signal is already aborted.
 */
export function attachAbortKill(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) return () => undefined;
  const kill = () => {
    onAbort();
    guardedKill(child, "abort");
  };
  if (signal.aborted) {
    kill();
    return () => undefined;
  }
  signal.addEventListener("abort", kill, { once: true });
  return () => signal.removeEventListener("abort", kill);
}
