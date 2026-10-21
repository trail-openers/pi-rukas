/**
 * process-liveness — the one answer this repo gives to "is that pid there?".
 *
 * Extracted from `work-driver-resume.ts` when the stale-lock sweep needed the
 * same predicate (#1740). It was previously imported out of the resume module,
 * which made a lockfile judge depend on the state-file machinery for a
 * two-syscall question; a leaf with no imports is what both callers should
 * depend on. `work-driver-resume.ts` re-exports it, so existing importers keep
 * working and the resume tests keep naming the module they were written
 * against.
 */

/**
 * Is this process still alive?
 *
 * `kill(pid, 0)` sends no signal and only tests reachability. EPERM means the
 * pid exists but belongs to another user — still alive, so still an owner.
 * Pid reuse can in principle make a dead owner look live; the failure mode is
 * refusing to resume, which is the safe direction.
 *
 * A SIGSTOPped process, and a zombie whose parent never reaped it, also answer
 * here. Neither can release a lockfile, which is why a liveness voucher alone
 * must never be the last word on a stale lock — see `stale-lock-sweep.ts`'s
 * hard ceiling.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
