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
 * handle alone. Group kills are tracked so the runner can reap them on exit.
 *
 * SIGTERM goes to the group first; SIGKILL follows after KILL_GRACE_MS for
 * anything that ignores SIGTERM. The escalation fires even when the leader has
 * already exited, because its descendants may still be running. If the group
 * is already gone (ESRCH) we fall back to the leader handle, which is a no-op
 * for an exited child.
 *
 * Normal exit is untouched: nothing here runs unless a kill was requested.
 */

import type { ChildProcess } from "node:child_process";

/** Grace between SIGTERM and SIGKILL for a process group. */
export const KILL_GRACE_MS = 2_000;

/** Spawn options for a child: its own process group only when a headless run asks. */
export function groupSpawnOpts(processGroup: boolean): { detached: boolean } {
  return { detached: processGroup };
}

/** Group children still running, so the headless runner can reap them on exit. */
const liveGroups = new Set<ChildProcess>();

/** Track a group child until it exits (see killLiveProcessGroups). */
export function trackProcessGroup(child: ChildProcess): void {
  liveGroups.add(child);
  child.once("exit", () => liveGroups.delete(child));
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
 * SIGTERM the child (its whole group when `processGroup`), SIGKILL after
 * KILL_GRACE_MS. A group kill's escalation timer stays ref'd: the runner must
 * not exit before SIGKILL lands, or the group outlives it.
 */
export function killProcessTree(child: ChildProcess, processGroup = false): void {
  signalChild(child, "SIGTERM", processGroup);
  const escalate = setTimeout(() => signalChild(child, "SIGKILL", processGroup), KILL_GRACE_MS);
  if (!processGroup) escalate.unref();
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
