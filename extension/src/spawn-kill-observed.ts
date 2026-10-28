/**
 * spawn-kill-observed — "someone has tried to KILL this child", for one spawn.
 *
 * `awaitExitWithin` (spawn-exit-await.ts) bounds the wait for a killed child's
 * `exit` event, and the bound is a GRACE: 15 s from the kill, not from the
 * spawn. That distinction is the v0.14.30 hotfix — the ceiling used to arm when
 * the await was entered, and the await is entered for the child's whole life, so
 * every subagent was SIGKILLed 15 s after it started. To time a grace the await
 * has to be TOLD, and the telling happens at the one choke point every kill
 * already passes through.
 *
 * Seven owners end a child from outside, and each records its cause somewhere
 * else, so no flag list covers them: the wall-clock backstop
 * (`spawn-supervision.ts` `createWallClockBackstop`, which spawn.ts routes
 * through `childBound.atBackstop` first, #1521); Pi's user-cancel
 * (`spawn-supervision.ts` `attachAbortKill`); the model-silence and
 * tool-inactivity kills (`spawn-inflight.ts` `createInactivityPoll`); the F1
 * loop cap and F6 token-budget cap (`spawn-caps.ts` `killChild`); and the
 * per-child run bound in all three of its endings — the bound kill, the #1521
 * settled-child reap, and the backstop takeover — plus the #1827 reviewer
 * bounds, the skill re-read kill and the post-verdict stop.
 *
 * All seven call `killProcessTree` (`spawn-kill.ts`), which notifies the seam
 * installed here before it signals anything. That is why this is a seam on the
 * kill rather than an OR over the kill flags: a flag list is a list someone has
 * to keep up to date when the eighth supervisor lands, and a missed entry is
 * the bug this file exists to fix. `killed()` reads the seam's own record, so
 * there is exactly one source for "this child was killed".
 *
 * The record is one-directional: a signalled child stays signalled, so once the
 * grace has started it keeps running. A false positive costs a child its grace
 * early (it was being killed anyway, by the same owner, moments later), and a
 * false negative is not available — the notification runs ahead of the signal and
 * outside its try/catch, so a kill whose SIGTERM never lands still ends its own
 * wait.
 */

import type { ChildProcess } from "node:child_process";
import { installKillSeam } from "./spawn-kill.ts";

export interface KillObserver {
  /**
   * The seam `killProcessTree` calls before it signals. Records the kill; the
   * waiting dispatch notices on its own tick. Idempotent, and safe to call for
   * a child nobody is waiting on (a bare `killProcessTree` from a test, or from
   * the group reaper, is then just a kill).
   */
  notifyKill(): void;
  /** True once a kill has been observed — i.e. once someone decided this child
   *  dies. Until then the exit await has no deadline. */
  killed(): boolean;
}

/**
 * The observer + its seam on ONE child, in one call, so the two halves of the
 * #1863 wiring cannot be separated by a later edit. `spawn-exit-await-session.ts`
 * is the only production caller: it runs right after `registerChild` and BEFORE
 * any supervisor is armed, and passes `killed` to the wait.
 *
 * A caller that does not need to read the predicate can ignore the return value:
 * `killProcessTree` holds the seam on the child itself, so a kill reaches the
 * observer whether or not anyone keeps the handle.
 */
export function installKillObserver(child: ChildProcess): KillObserver {
  const observer = createKillObserver();
  installKillSeam(child, observer.notifyKill);
  return observer;
}

export function createKillObserver(): KillObserver {
  let killed = false;
  return {
    notifyKill: () => {
      killed = true;
    },
    killed: () => killed,
  };
}
