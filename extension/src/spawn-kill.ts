/**
 * spawn-kill — terminate a spawned child AND every process it forked (#1024).
 *
 * A headless cycle's children are spawned `detached: true`, which makes each
 * one the leader of its own process group. `process.kill(-pid, sig)` then
 * reaches the whole tree: the `sleep` a shell backgrounded, the ssh a git call
 * spawned. `child.kill()` signals the leader alone, so a grandchild survived
 * every abort, timeout and inactivity kill and was orphaned.
 *
 * Only the headless runner asks for a group (`processGroup`). An interactive
 * Pi session keeps its children in the terminal's foreground process group, so
 * Ctrl-C reaches them as it always did; for those, a kill signals the leader
 * handle alone.
 *
 * The group decision is made once, at spawn time, and stored on the child
 * handle (`registerChild`). Every kill site then reads that one policy through
 * `killProcessTree(child)`; no caller restates it. Group children are tracked
 * so the runner can reap them on exit.
 *
 * Escalation: SIGTERM first, then SIGKILL after a grace period. A group kill
 * uses KILL_GRACE_MS and keeps its timer ref'd (the runner must not exit before
 * the group is gone); an interactive kill keeps the 5 s escalation, unref'd.
 * The escalation fires even when the leader has already exited, because its
 * descendants may still be running. If the group is already gone (ESRCH) we
 * fall back to the leader handle, which is a no-op for an exited child.
 *
 * Normal exit is untouched: nothing here runs unless a kill was requested.
 */

import type { ChildProcess } from "node:child_process";

/** Grace between SIGTERM and SIGKILL for a process group (headless). */
export const KILL_GRACE_MS = 2_000;

/** Grace between SIGTERM and SIGKILL for a lone leader (interactive). */
export const INTERACTIVE_KILL_GRACE_MS = 5_000;

/** Spawn options for a child: its own process group only when a headless run asks. */
export function groupSpawnOpts(processGroup: boolean): { detached: boolean } {
  return { detached: processGroup };
}

/** The group decision recorded for each child at spawn time. */
const groupPolicy = new WeakMap<ChildProcess, boolean>();

/** Group children still running, so the headless runner can reap them on exit. */
const liveGroups = new Set<ChildProcess>();

/**
 * Record a child's group policy at spawn time. A group child is also tracked
 * until it exits (see killLiveProcessGroups). Call before any kill can happen.
 */
export function registerChild(child: ChildProcess, processGroup: boolean): void {
  groupPolicy.set(child, processGroup);
  if (!processGroup) return;
  liveGroups.add(child);
  child.once("exit", () => liveGroups.delete(child));
}

/** True when the child was registered as a process-group leader. */
export function isGroupChild(child: ChildProcess): boolean {
  return groupPolicy.get(child) === true;
}

function signalGroupPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false; // Group already gone (ESRCH), or the platform has no process groups.
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean): void {
  if (processGroup && child.pid !== undefined && signalGroupPid(child.pid, signal)) return;
  // Not a group leader, no pid, or the group is already gone: signal the leader handle.
  try {
    child.kill(signal);
  } catch {
    // Leader already reaped — nothing left to signal.
  }
}

/**
 * SIGTERM the child (its whole group when it was registered as one), SIGKILL
 * after the policy's grace period.
 */
export function killProcessTree(child: ChildProcess): void {
  const group = isGroupChild(child);
  signalChild(child, "SIGTERM", group);
  const escalate = setTimeout(
    () => signalChild(child, "SIGKILL", group),
    group ? KILL_GRACE_MS : INTERACTIVE_KILL_GRACE_MS,
  );
  if (!group) escalate.unref();
}

/**
 * Synchronously SIGKILL every tracked group. For the runner's `exit` and
 * SIGHUP handlers, where no timer can run.
 */
export function killLiveProcessGroups(): void {
  for (const child of liveGroups) {
    if (child.pid !== undefined) signalGroupPid(child.pid, "SIGKILL");
  }
  liveGroups.clear();
}
