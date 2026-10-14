/**
 * spawn-kill — terminate a spawned child AND every process it forked (#1024).
 *
 * Children are spawned `detached: true`, which makes each one the leader of
 * its own process group. `process.kill(-pid, sig)` then reaches the whole tree:
 * the `sleep` a shell backgrounded, the ssh a git call spawned. `child.kill()`
 * signals the leader alone, so a grandchild survived every abort, timeout and
 * inactivity kill and was orphaned — the bug this module exists to close.
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

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone (ESRCH), or the platform has no process groups.
    }
  }
  // No pid (spawn never produced one) or no group left: signal the leader handle.
  try {
    child.kill(signal);
  } catch {
    // Leader already reaped — nothing left to signal.
  }
}

/** SIGTERM the child's process group now, SIGKILL it after KILL_GRACE_MS. */
export function killProcessTree(child: ChildProcess): void {
  signalGroup(child, "SIGTERM");
  setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
}
