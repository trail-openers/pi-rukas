/**
 * spawn-exit-await-session — the exit await of ONE spawn, wired.
 *
 * `spawnSpecialistInner` ends with `await`ing its child's `exit`, and the three
 * pieces that make that wait correct are the ones the v0.14.30 hotfix changed:
 *
 *   1. the kill OBSERVER (`spawn-kill-observed.ts`) — a flag no kill owner has to
 *      remember to set, because `killProcessTree` notifies it itself;
 *   2. the seam installation (`installKillSeam` in `spawn-kill.ts`) — attached
 *      here, next to `registerChild`, so a kill cannot land in a window where
 *      nothing is watching;
 *   3. the bounded wait itself (`awaitExitWithin` in `spawn-exit-await.ts`) —
 *      which has NO deadline until that observer says a kill happened.
 *
 * They are one function because their ORDERING is load-bearing and a caller who
 * gets it wrong gets the bug back: install the seam BEFORE any supervisor is
 * armed (every supervisor in `spawn.ts` — the backstop, the abort arm, the caps
 * and the bound — is armed after this returns), and enter the await after it.
 * It lives in its own module rather than inline because `spawn.ts` sits at the
 * AGENTS.md §12 size cap and the alternative was to compress the reasoning that
 * keeps the next maintainer from "simplifying" the predicate back into a flag.
 *
 * Nothing here decides policy: how long the grace is belongs to
 * `spawn-exit-await.ts`, and who is allowed to kill a child belongs to the
 * supervisors themselves.
 */

import type { ChildProcess } from "node:child_process";
import { EXIT_AWAIT_GRACE_MS, awaitExitWithin } from "./spawn-exit-await.ts";
import { createKillObserver } from "./spawn-kill-observed.ts";
import { installKillSeam, killProcessTree } from "./spawn-kill.ts";

/** What `spawn.ts` holds onto: the wait, and nothing else. */
export interface ChildExitWait {
  /** Resolves with the child's `[code, signal]`, at most a grace past its kill. */
  promise: Promise<[number | null, NodeJS.Signals | null]>;
  /** True once any supervisor has killed this child. The spawn does not read it
   *  (its kill-cause attribution comes from the flags each supervisor sets);
   *  exposing it keeps the predicate testable and stops it being write-only. */
  killed(): boolean;
}

/**
 * Wire and start the exit wait for `child`. Call this immediately after
 * `registerChild`/`attachAbortKill` and immediately before the `finally` block
 * that tears the supervisors down — see the module doc for the ordering that
 * makes it correct.
 */
export function awaitChildExit(child: ChildProcess): ChildExitWait {
  // #1863 hotfix (v0.14.30) — the grace clock starts AT THE KILL. ONE predicate
  // is what the await waits on, and it is set by `killProcessTree` itself, so
  // every owner that can end this child is covered by construction rather than
  // by a list someone maintains: the wall-clock backstop, Pi's user-cancel, both
  // inactivity arms, the loop and token-budget caps, the run bound (its kill,
  // its settled-child reap and its backstop takeover) and the #1827 reviewer
  // bounds. Before any of them fires, the exit await has NO deadline at all —
  // which is what the whole-life 15 s ceiling used to impose on every subagent.
  const observer = createKillObserver();
  installKillSeam(child, observer.notifyKill);
  return {
    killed: observer.killed,
    promise: awaitExitWithin(child, {
      graceMs: EXIT_AWAIT_GRACE_MS,
      killed: observer.killed,
      // Re-signal the tree if the grace expires: a child that ignored the first
      // SIGTERM must not be left running behind the result we report.
      kill: () => killProcessTree(child),
    }),
  };
}
