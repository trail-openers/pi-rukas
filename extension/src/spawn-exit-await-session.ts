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
 * They are one module because their ORDERING is load-bearing and a caller who
 * gets it wrong gets the bug back: `installExitKillSeam` runs right after
 * `registerChild` and BEFORE every supervisor in `spawn.ts` — the backstop, the
 * caps, the bound, the inactivity poll and the abort arm — is armed, and
 * `startExitWait` is entered after them all. If `spawn.ts` inlined them, the
 * install would sit at the tail with the supervisors above it and a kill from
 * the earliest armed timer could land before anything was watching. It lives in
 * its own module rather than inline because `spawn.ts` sits at the AGENTS.md §12
 * size cap and the alternative was to compress the reasoning that keeps the next
 * maintainer from "simplifying" the predicate back into a flag.
 *
 * Nothing here decides policy: how long the grace is belongs to
 * `spawn-exit-await.ts`, and who is allowed to kill a child belongs to the
 * supervisors themselves.
 */

import type { ChildProcess } from "node:child_process";
import { EXIT_AWAIT_GRACE_MS, awaitExitWithin } from "./spawn-exit-await.ts";
import { installKillObserver } from "./spawn-kill-observed.ts";
import { killProcessTree } from "./spawn-kill.ts";

/** What `spawn.ts` holds onto: the wait, and nothing else. */
export interface ChildExitWait {
  /** Resolves with the child's `[code, signal]`, at most a grace past its kill. */
  promise: Promise<[number | null, NodeJS.Signals | null]>;
}

/**
 * Install the kill OBSERVER + SEAM for `child`. Call this immediately after
 * `registerChild` and BEFORE any supervisor is armed — see the module doc for
 * why the ordering is the fix rather than a nicety.
 *
 * Returns the predicate the wait needs (`killed`); pass it to
 * `startExitWait` when the spawn reaches its exit await. Keeping the two calls
 * separate is what lets the seam exist from the first instant of the child's
 * life while the wait itself is entered at the end of the spawn.
 */
export function installExitKillSeam(child: ChildProcess): () => boolean {
  // #1863 hotfix (v0.14.30) — the grace clock starts AT THE KILL. ONE predicate
  // is what the await waits on, and it is set by `killProcessTree` itself, so
  // every owner that can end this child is covered by construction rather than
  // by a list someone maintains: the wall-clock backstop, Pi's user-cancel, both
  // inactivity arms, the loop and token-budget caps, the run bound (its kill,
  // its settled-child reap and its backstop takeover) and the #1827 reviewer
  // bounds. Before any of them fires, the exit await has NO deadline at all —
  // which is what the whole-life 15 s ceiling used to impose on every subagent.
  return installKillObserver(child).killed;
}

/**
 * Enter the bounded wait for `child`'s exit, using the predicate
 * `installExitKillSeam` returned. Call this where the spawn's `try` block
 * begins, immediately before `await`ing the promise.
 */
export function startExitWait(child: ChildProcess, killed: () => boolean): ChildExitWait {
  return {
    promise: awaitExitWithin(child, {
      graceMs: EXIT_AWAIT_GRACE_MS,
      killed,
      // Re-signal the tree if the grace expires: a child that ignored the first
      // SIGTERM must not be left running behind the result we report.
      kill: () => killProcessTree(child),
    }),
  };
}
