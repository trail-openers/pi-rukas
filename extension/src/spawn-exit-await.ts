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
 * suite hung on an un-killed child that nothing could drain away. So the handle
 * polls and does nothing until `killed()` says true, and the spawn installs its
 * kill observer next to `registerChild` — before any supervisor is armed — so a
 * kill can never land in a window where nothing is watching. From that tick the
 * handle owns the grace, and every path through this function clears it: a
 * normal dispatch leaves no timer behind, and a wedged one cannot drain the loop
 * out from under itself.
 *
 * THE POLL READS LIVENESS BEFORE IT SIGNS ANYTHING. A child that has already
 * exited — `child.exitCode != null || child.signalCode != null`, the project's
 * one predicate `childHasExited` — has exited, whether or not the `exit` event
 * reached this await. Node fills those fields
 * when it reaps the child and only emits `exit` on the next turn of the loop,
 * so between the two there is a real window in which a poll that ignored them
 * would re-signal a dead child and hand back `[null, null]`. Every tick checks
 * liveness first, and so does the branch that is about to re-kill: the wedge
 * verdict is only ever reached for a child that is genuinely still running.
 *
 * The fix cannot be to ref the child's handle (that restores the hang,
 * differently), and must not be to trust the escalation alone:
 * `killProcessTree`'s SIGKILL is unref'd for a child that is not a registered
 * group leader, so a non-group child's escalation cannot fire once the loop
 * drains. So this waits for the exit event AND for a grace that starts when a
 * kill is observed, and re-signals on the way out — for a child that is still
 * running — so a wedged tree is not left running behind the result.
 */

import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { childHasExited } from "./spawn-support.ts";
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
 * It is a GRACE, so it is measured from the KILL, never from the spawn: the
 * countdown starts on the first tick that observes one. A spawn-wide deadline is
 * what killed every subagent 15 s after it started in v0.14.30.
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
 * EVERY TIMER IS CLEARED ON EVERY PATH — exit, already-exited, wedge, or a
 * rejection from the event helper. That contract is what makes the handle safe to
 * keep ref'd: the longest it can exist is one child's post-kill grace.
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
    // THE LIVESS CHECK, the one the wedge verdict must never contradict: Node
    // fills `exitCode` / `signalCode` when it reaps the child, and either being
    // non-null means the child is GONE — whatever the event queue still owes
    // this await. See the module doc for why the check leads every tick.
    //
    // It is the project's ONE liveness predicate (#1847, `childHasExited`), so
    // the wait agrees with the caps stack and the child bound about whether this
    // child may still be killed. This call has no kill-flags accessor to offer
    // (the spawn's kill seam arrives as `killed()` instead), so `undefined` lets
    // the handle's own fields decide — read with the NULLISH operator, because a
    // fake child that simply omits the two leaves them `undefined`, and an
    // exact-`null` comparison would call such a child not-yet-exited.
    const hasExited = () => childHasExited(undefined, child);
    const resolveExited = (): void => {
      stopHandles();
      resolve([child.exitCode ?? null, child.signalCode ?? null]);
      // Reached only from the poll, never from the `exit` event, so the trace is
      // the record of an exit nobody observed through the event.
      trace(
        `spawn-exit-await: child ${child.pid ?? "?"} had already exited (code ${child.exitCode}, signal ${child.signalCode}) but the exit event never reached the await — resolved without re-signalling it`,
      );
    };
    // THE TWO HANDLES THIS MODULE OWNS, and why neither is a stopwatch. The poll
    // is ref'd ON PURPOSE and does only two things: read liveness, and read the
    // kill flag (arming a ref'd grace on entry is the whole-life-death bug
    // again). The grace is the OTHER handle — ONE `setTimeout(graceMs)` armed on
    // the tick that FIRST observes the kill — so the wait ends at kill + graceMs
    // whatever the poll's period happens to be. Measuring the grace off
    // `Date.now()` inside the tick instead made the real deadline a multiple of
    // `pollMs`: with the 1 s default a 15 s grace was up to 16 s, and a caller
    // that set `pollMs` near its own bound could not tell. Both handles are
    // cleared on every path, including a tick that throws.
    let grace: ReturnType<typeof setTimeout> | undefined;
    // `killed()` defaults to true so a caller with no kill seam keeps the
    // pre-hotfix contract: the grace is armed by the very first tick.
    const isKilled = opts.killed ?? (() => true);
    // THE ONE PLACE EITHER HANDLE IS RELEASED, so no path can clear one and keep
    // the other. Called before `resolve` on every route out of this await.
    const stopHandles = (): void => {
      clearInterval(handle);
      if (grace !== undefined) clearTimeout(grace);
    };
    // A tick that throws must not leave a ref'd interval running: `killed()` is
    // caller code and `hasExited()` reads a handle, so either blowing up would
    // otherwise keep the loop alive forever AND never settle the dispatch that is
    // counting on this await. Report what the handle does know, and stop.
    const failTick = (err: unknown): void => {
      trace(
        `spawn-exit-await: the grace handle failed for child ${child.pid ?? "?"}: ${String(err)} — resolving the wait from the child's own fields`,
      );
      stopHandles();
      resolve([child.exitCode ?? null, child.signalCode ?? null]);
    };
    // The grace expired on a child neither handle has seen exit: the wedge the
    // field symptom left unresolved forever. The escalation has had its turn
    // (spawn-kill.ts armed it when it killed), so signal once more on the way
    // out and do not leave the tree running behind the result we report.
    const resolveWedged = (): void => {
      try {
        opts.kill?.();
      } catch (err) {
        trace(`spawn-exit-await: re-kill of the wedged child failed: ${String(err)}`);
      }
      stopHandles();
      trace(
        `spawn-exit-await: child ${child.pid ?? "?"} never reported exit within ${graceMs}ms after the kill — resolving without it`,
      );
      resolve([child.exitCode ?? null, child.signalCode ?? null]);
    };
    const tick = (): void => {
      try {
        // LIVENESS FIRST, on every tick — and it never contradicts the wedge
        // verdict below, which is reached only for a child still running.
        if (hasExited()) {
          resolveExited();
          return;
        }
        if (grace !== undefined) return; // already armed; the expiry decides
        if (!isKilled()) return;
        // THE ONE ARMING SITE: one timer, from the kill, for exactly the grace.
        grace = setTimeout(() => {
          try {
            // Re-read liveness: the grace expired, but a child that exited while
            // nobody was looking must be reported as exited, not signalled again.
            if (hasExited()) {
              resolveExited();
              return;
            }
            resolveWedged();
          } catch (err) {
            failTick(err);
          }
        }, graceMs);
      } catch (err) {
        failTick(err);
      }
    };
    const handle = setInterval(tick, pollMs);
    // The exit event wins outright — no grace, no re-kill.
    void settled.then((winner) => {
      stopHandles();
      const [code, signal] = winner;
      // The tuple may still be missing values (a reaped child whose fields Node
      // filled in only on `close`).
      resolve([code ?? child.exitCode ?? null, signal ?? child.signalCode ?? null]);
    });
  });
}
