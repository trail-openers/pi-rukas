/**
 * work-driver-path-claims-lock-sweep — the stale-holder judge and the
 * compare-and-delete that removes a corpse lock.
 *
 * Split from `work-driver-path-claims-lock.ts` for the 500-line gate
 * (AGENTS.md §12), along the seam the code already had: `acquire` owns the
 * test-and-set (O_EXCL create, token publish, release), and everything about
 * judging whether the CURRENT holder is a corpse lives here. The two halves
 * must still be read together — the sweep's whole contract is that it never
 * touches a lock the acquire side might be publishing.
 *
 * #1640 is the reason this is a module of its own with one exported verb: the
 * judgment and the delete are ONE operation, and any future caller that
 * reaches for a `readFile` + `rm` pair instead reproduces the lost-update bug
 * this replaced (async read straddling an unlink+create, then an unconditional
 * `fs.rm` by path deleting whatever the path held — including a live holder's
 * lock). There is deliberately no exported "read the lock age" primitive.
 */

import { readFileSync, statSync, unlinkSync } from "node:fs";
import { processAlive } from "./work-driver-resume.ts";

/**
 * A lock whose holder is older than this is a corpse (a killed process left
 * it behind). Far beyond any plausible hold, short enough that a crashed
 * cycle does not park the registry for the rest of the session.
 */
export const LOCK_STALE_MS = 60_000;

/** What the waiter learned about the current holder. */
export type HolderRead =
  | { status: "stale"; ageMs: number; pid: number | null }
  | { status: "alive" }
  | { status: "unreadable" };

/**
 * Read the lockfile and judge its holder — and when it IS provably a corpse,
 * delete exactly that corpse, in one event-loop turn.
 *
 * #1640 — this function used to be async (`await fs.readFile`) and the caller
 * deleted with a SECOND, separate `await fs.rm(file, { force: true })`. Both
 * halves were broken, and together they let a waiter destroy a LIVE lock:
 *
 *   1. `fs.readFile` is open-later/read-later through the thread pool. Issued
 *      while holder C's lockfile exists, its fd pins C's inode, so the bytes
 *      can reach the caller AFTER the path has been unlinked and re-created
 *      by a new holder D (unlink does not invalidate an open fd; POSIX
 *      guarantees the read returns C's bytes). The stale verdict then
 *      describes a file that is no longer at the path at all.
 *   2. `fs.rm(file, { force: true })` deletes by PATH, unconditionally — so
 *      it removed D's live lock, whatever the read had described.
 *
 * Measured (repro of #1640, 8 children released from a barrier, one run in
 * ~30): waiter 16688's read returned dead child 16682's token 4ms after
 * 16682's lock had been replaced (16683 created at +1ms, 16684 at +4ms);
 * 16688's `fs.rm` then unlinked 16684's live lock. 16684 and 16688 held the
 * "lock" simultaneously, both read the same snapshot, and 16684's rename
 * dropped 16688's just-published claim. The fingerprint was 16684's release
 * finding its own token gone (`holds=false`) while it had never lost
 * ownership.
 *
 * The fix is the same-tick discipline the lock already applies to token
 * publication (`openSync` + `writeFileSync(fd, …)` in `acquire`): every
 * observation and the unlink run in ONE event-loop turn, synchronously, and
 * the unlink fires only after the file at the path is re-validated to be the
 * same inode, byte-for-byte, that was judged. There is no await between
 * judging the corpse and deleting it, so no other process can be scheduled
 * into the gap, and the delete is conditional on the identity of what is
 * actually there.
 *
 * `stale` requires BOTH signals the name implies: the token parsed AND (its
 * `at` past the stale window OR its pid provedly gone). Anything else —
 * unreadable, unparsable, zero-byte, an `at` we cannot parse, an inode that
 * changed under us mid-check — is `alive`, i.e. "wait". That asymmetry is the
 * whole point: the cost of waiting on a corpse is bounded by the next poll and
 * eventually by the deadline, while the cost of deleting a live holder's lock
 * is two writers in the body at once — the exact lost update the lock exists
 * to remove.
 *
 * A holder whose pid has exited is swept early: a killed process cannot
 * release, so its lock would otherwise pin the registry for the full stale
 * window across every concurrent cycle.
 */
export function sweepStaleLock(file: string): HolderRead {
  let first: ReturnType<typeof statSync>;
  try {
    first = statSync(file);
  } catch {
    return { status: "unreadable" };
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { status: "unreadable" };
  }
  let second: ReturnType<typeof statSync>;
  try {
    second = statSync(file);
  } catch {
    return { status: "unreadable" };
  }
  // The path was replaced while we were looking at it (a replace is always
  // unlink + create, hence a NEW inode). We can no longer vouch for what the
  // bytes we read describe, so we wait rather than judge.
  if (second.ino !== first.ino) return { status: "alive" };
  let parsed: { pid?: unknown; at?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unreadable" };
  }
  const at = typeof parsed.at === "number" ? parsed.at : null;
  const pid = typeof parsed.pid === "number" ? parsed.pid : null;
  if (at === null) return { status: "alive" };
  const ageMs = Date.now() - at;
  // A corpse's lock is stale immediately — but only when the token parsed, so
  // a half-published file is never judged by a field we could not read.
  const deadOwner = pid !== null && pid !== process.pid && !processAlive(pid);
  if (ageMs <= LOCK_STALE_MS && !deadOwner) return { status: "alive" };
  // Last voucher, immediately adjacent to the unlink: same inode, same size,
  // byte-identical content, holder still not alive (a recycled pid counts as
  // alive). If any of it fails, we wait — deleting is the unbounded-cost
  // direction.
  try {
    const now = statSync(file);
    if (now.ino !== first.ino || now.size !== first.size) return { status: "alive" };
    if (readFileSync(file, "utf8") !== raw) return { status: "alive" };
    if (pid !== null && pid !== process.pid && processAlive(pid)) return { status: "alive" };
    unlinkSync(file);
  } catch {
    // Gone already (a sibling's verified sweep got it first) or unreadable
    // again mid-check: treat as alive and let the next poll decide.
    return { status: "alive" };
  }
  return { status: "stale", ageMs, pid };
}
