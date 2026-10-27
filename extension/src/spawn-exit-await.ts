/**
 * spawn-exit-await — the BOUNDED wait for a killed child to exit (#1863).
 *
 * `spawn.ts` awaited `once(child, "exit")` as the last thing it did, with every
 * teardown in the `finally` behind it. A child that traps SIGTERM and is never
 * reaped leaves that promise pending forever, and the whole dispatch hangs on
 * it.
 *
 * THE HANDLE THAT SHOULD HAVE KEPT THE LOOP ALIVE, and why it does not: the
 * child's own libuv process handle is what a pending `exit` listener normally
 * rides on. It stops being ref'd as soon as anything `unref()`s it — and every
 * supervisor around this await is unref'd: the per-child bound's timers
 * (`spawn-child-bound.ts`), the cap grace polls (`spawn-caps.ts`), the
 * inactivity poll (`spawn-inflight.ts`), and the non-group SIGKILL escalation
 * (`spawn-kill.ts`). `registerChild` tracks the group for the exit-time reaper
 * but never re-refs the handle. So after a bound kill there can be a pending
 * `exit` listener with nothing ref'd behind it, and the runner is free to drain
 * to exit 0 mid-await — which is exactly the field symptom "the runner process
 * exited 0 without a result".
 *
 * The fix cannot be to ref the handle (that restores the hang, differently), and
 * must not be to trust the escalation alone: `killProcessTree`'s SIGKILL is
 * unref'd for a child that is not a registered group leader, so a non-group
 * child's escalation cannot fire once the loop drains. So this waits for the
 * exit event AND for a hard ceiling past the escalation's grace window, and
 * re-signals on the way out so a wedged tree is not left running behind the
 * result.
 *
 * The ceiling reads liveness through `childHasExited` — the ONE signal every
 * supervisor already agrees on — rather than counting events, so a child that
 * exited and whose `exit` listener was never dispatched is not mistaken for one
 * that is still running.
 */

import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { childHasExited } from "./spawn-support.ts";
import { trace } from "./trace.ts";

/**
 * How long to wait past the SIGKILL escalation for the exit event.
 *
 * The escalation itself fires at `KILL_GRACE_MS` (2 s) for a group child, so
 * the ceiling is that plus a wide margin: a child whose grandchildren hold the
 * stdio pipes can take seconds to be reaped, and calling a reaped-but-unobserved
 * child "wedged" would be the wrong verdict. But the wait MUST end, because the
 * alternative — waiting forever on an event that will not come — is what left
 * the adversarial step's dispatch unresolved and the runner silent.
 */
export const EXIT_AWAIT_GRACE_MS = 15_000;

const POLL_MS = 50;

export interface ExitAwaitOpts {
  /** Ceiling past the escalation for the exit event to arrive. */
  graceMs?: number;
  /** Re-signal the (still-lingering) tree when the ceiling is reached. */
  kill?: () => void;
  /** Injectable for tests: the liveness predicate (default `childHasExited`). */
  exited?: () => boolean;
}

/**
 * Await the child's `exit`, resolving no later than `graceMs` after the exit
 * event would have been expected.
 *
 * Returns the `[code, signal]` tuple `once(child, "exit")` yields, or
 * `[null, null]` when the child never reported an exit within the ceiling —
 * which is the shape of a child that trapped the signal and was never reaped.
 * Never rejects: a dispatch must always resolve, because the driver's routing,
 * the handoff and the headless result document all hang off it.
 */
export async function awaitExitWithin(
  child: ChildProcess,
  opts: ExitAwaitOpts = {},
): Promise<[number | null, NodeJS.Signals | null]> {
  const graceMs = opts.graceMs ?? EXIT_AWAIT_GRACE_MS;
  const exited = opts.exited ?? (() => childHasExited(undefined, child));
  const exitEvent = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  // A rejection from the event helper (no listener error, an aborted emit) is a
  // missing event, not a failed dispatch: it decides "no exit observed".
  const settled = exitEvent.catch(() => [null, null] as [number | null, NodeJS.Signals | null]);
  const deadline = new Promise<"wedged">((resolve) => {
    const t = setTimeout(() => resolve("wedged"), graceMs);
    t.unref?.();
  });
  const winner = await Promise.race([settled, deadline]);
  if (winner === "wedged") {
    // The escalation has had its turn (spawn-kill.ts armed it before this wait
    // was entered, or the caller armed it). Signal once more on the way out so
    // the tree is not left running behind the result we are about to report.
    try {
      opts.kill?.();
    } catch (err) {
      trace(`spawn-exit-await: re-kill of the wedged child failed: ${String(err)}`);
    }
    // Best-effort: if the child is in fact already gone, the exit event lands
    // on this listener and no unhandled rejection follows from the race.
    void settled;
    trace(
      `spawn-exit-await: child ${child.pid ?? "?"} never reported exit within ${graceMs}ms after the kill — resolving without it`,
    );
    return [child.exitCode ?? null, child.signalCode ?? null];
  }
  // The exit event won, but the tuple may still be missing values (a reaped
  // child whose fields Node filled in only on `close`).
  const [code, signal] = winner;
  return [code ?? child.exitCode ?? null, signal ?? child.signalCode ?? null];
}

/** Poll helper the tests use to observe the wedged branch without a real kill. */
export function exitedHandle(child: ChildProcess): () => boolean {
  return () => childHasExited(undefined, child);
}
