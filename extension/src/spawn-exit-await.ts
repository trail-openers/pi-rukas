/**
 * spawn-exit-await — the BOUNDED wait for a KILLED child to exit (#1863).
 *
 * `spawn.ts` awaited `once(child, "exit")` as the last thing it did, with every
 * teardown in the `finally` behind it. A child that traps SIGTERM and is never
 * reaped leaves that promise pending forever, and the whole dispatch hangs on
 * it.
 *
 * THE DEADLINE STARTS AT THE KILL, NOT AT THE SPAWN (the v0.14.30 hotfix). The
 * first cut armed its ceiling the moment this function was entered, and
 * `spawn.ts` enters it for the child's WHOLE life — so a 15 s ceiling measured
 * from spawn, and every subagent was SIGKILLed 15 s after it started. The bound
 * is a grace for a child that has already been told to die and has to be read
 * that way: while nobody has killed the child there is no deadline at all and
 * the wait is the plain `once(child, "exit")` it always was, because a child
 * that is still working has no reason to have a stopwatch running on it. The
 * grace starts when `killed()` first says true — which is the seam
 * `killProcessTree` notifies, so no kill path can miss it.
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
 * THE HANDLE IS ONE POLL, REF'd, AND THE GRACE BEGINS ON THE TICK THAT SEES THE
 * KILL. Two shapes that look right and are not. The poll MUST be ref'd: an
 * unref'd one never runs once the loop has nothing else ref'd, which is exactly
 * the wedged case it exists to save — and it is what the old
 * `await once(child, "exit")` had gone. But a ref'd poll must not *act* for an
 * un-killed child, because `spawn.ts` enters this await for the child's whole
 * life: an early cut of this hotfix armed a ref'd grace on entry and the offline
 * suite hung on an un-killed 20 s child that nothing could drain away. So the
 * handle polls and does nothing until `killed()` says true, and the spawn
 * installs its kill observer next to `registerChild` — before any supervisor is
 * armed — so a kill can never land in a window where nothing is watching. From
 * that tick the handle owns the grace, and every path through this function
 * clears it: a normal dispatch leaves no timer behind, and a wedged one cannot
 * drain the loop out from under itself.
 *
 * The fix cannot be to ref the child's handle (that restores the hang,
 * differently), and must not be to trust the escalation alone:
 * `killProcessTree`'s SIGKILL is unref'd for a child that is not a registered
 * group leader, so a non-group child's escalation cannot fire once the loop
 * drains. So this waits for the exit event AND for a hard ceiling past the
 * escalation's grace window, and re-signals on the way out so a wedged tree is
 * not left running behind the result.
 *
 * The ceiling races the `exit` event itself rather than counting events or
 * polling liveness: `once(child, "exit")` is the one signal every supervisor
 * already agrees has fired, and the ceiling only decides when to stop waiting
 * for it. The exit tuple is completed from `child.exitCode` / `child.signalCode`
 * when the event arrives without them.
 */

import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { trace } from "./trace.ts";

/**
 * How long to wait AFTER A KILL for the exit event.
 *
 * The escalation itself fires at `KILL_GRACE_MS` (2 s) for a group child, so
 * the ceiling is that plus a wide margin: a child whose grandchildren hold the
 * stdio pipes can take seconds to be reaped, and calling a reaped-but-unobserved
 * child "wedged" would be the wrong verdict. But the wait MUST end, because the
 * alternative — waiting forever on an event that will not come — is what left
 * the adversarial step's dispatch unresolved and the runner silent.
 *
 * It is a GRACE, so it is measured from the kill, never from the spawn. A
 * spawn-wide deadline is what killed every subagent 15 s after it started in
 * v0.14.30.
 */
export const EXIT_AWAIT_GRACE_MS = 15_000;

export interface ExitAwaitOpts {
  /** Grace AFTER THE KILL for the exit event to arrive. */
  graceMs?: number;
  /**
   * Has anyone KILLED this child? Read once per tick of the grace handle. The
   * spawn passes the seam from `spawn-kill-observed.ts`, which is notified by
   * `killProcessTree` itself, so every kill path is covered by construction:
   * the wall-clock backstop, Pi's user-cancel, both inactivity arms, the loop
   * and token-budget caps, the per-child run bound (kill, reap, backstop
   * takeover) and the reviewer bounds.
   *
   * `undefined` means the caller has no kill seam to offer, and keeps the
   * pre-hotfix contract: the deadline starts immediately, as if the child had
   * been killed at spawn.
   */
  killed?: () => boolean;
  /** Re-signal the (still-lingering) tree when the grace expires. */
  kill?: () => void;
  /** How often the handle checks for the kill / measures the grace. */
  pollMs?: number;
}

/**
 * Await the child's `exit`, resolving no later than `graceMs` after
 * `killed()` first reported true.
 *
 * Before a kill there is NO deadline: a child nobody has signalled is simply
 * awaited, however long it takes — the spawn's own backstop, caps and bounds are
 * what make a child die, and each of them starts the grace on the way out. Once
 * armed, a child that still has not reported an exit when the grace expires
 * resolves from `child.exitCode` / `child.signalCode`, which is the shape of a
 * child that trapped the signal and was never reaped. Never rejects: a dispatch
 * must always resolve, because the driver's routing, the handoff and the headless
 * result document all hang off it.
 *
 * EVERY TIMER IS CLEARED ON EVERY PATH — exit, wedge, or a rejection from the
 * event helper. That contract is what makes the handle safe to keep ref'd: the
 * longest it can exist is one child's post-kill grace.
 *
 * #1863 — THE HANDLE, named: the old `once(child, "exit")` was kept alive only
 * by the child's own libuv process handle. Nothing supervising the child keeps it
 * alive — the bound's timers, the cap grace polls, the inactivity poll and this
 * module's ceiling are all `unref()`d — so once the child's handle stopped being
 * ref'd the only ref'd thing left was the 2 h wall-clock backstop, and a driver
 * that reached this await with a wedged child waited for an event that never came
 * while nothing it owned could still report anything. bun then drained the loop
 * and the runner was gone with no result document.
 */

export async function awaitExitWithin(
  child: ChildProcess,
  opts: ExitAwaitOpts = {},
): Promise<[number | null, NodeJS.Signals | null]> {
  const graceMs = opts.graceMs ?? EXIT_AWAIT_GRACE_MS;
  const pollMs = opts.pollMs ?? 1_000;
  const exitEvent = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  // A rejection from the event helper (no listener error, an aborted emit) is a
  // missing event, not a failed dispatch: it decides "no exit observed".
  const settled = exitEvent.catch(() => [null, null] as [number | null, NodeJS.Signals | null]);

  return await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    // The ONE handle this module owns, ref'd ON PURPOSE. Before a kill its tick
    // is a single flag read and nothing more (arming a ref'd grace on entry is
    // the whole-life-death bug again); once `killed()` turns true it starts the
    // grace and, `graceMs` later, ends the wait for a child that will not exit.
    let armedAt = 0;
    // `killed()` defaults to true so a caller with no kill seam keeps the
    // pre-hotfix contract: the deadline starts here, at the top of the tick.
    const isKilled = opts.killed ?? (() => true);
    const handle = setInterval(() => {
      if (armedAt === 0) {
        if (!isKilled()) return;
        armedAt = Date.now();
      }
      if (Date.now() - armedAt < graceMs) return;
      // The escalation has had its turn (spawn-kill.ts armed it when it
      // killed). Signal once more on the way out so the tree is not left
      // running behind the result we report.
      try {
        opts.kill?.();
      } catch (err) {
        trace(`spawn-exit-await: re-kill of the wedged child failed: ${String(err)}`);
      }
      clearInterval(handle);
      trace(
        `spawn-exit-await: child ${child.pid ?? "?"} never reported exit within ${graceMs}ms after the kill — resolving without it`,
      );
      resolve([child.exitCode ?? null, child.signalCode ?? null]);
    }, pollMs);
    // The exit event wins outright — no grace, no re-kill.
    void settled.then((winner) => {
      clearInterval(handle);
      const [code, signal] = winner;
      // The tuple may still be missing values (a reaped child whose fields Node
      // filled in only on `close`).
      resolve([code ?? child.exitCode ?? null, signal ?? child.signalCode ?? null]);
    });
  });
}
