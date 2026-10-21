/**
 * work-driver-path-claims-lock-sweep — the claims lock's view of the shared
 * stale-holder sweep.
 *
 * The judge-and-delete itself is one leaf, `stale-lock-sweep.ts`, shared with
 * the integration lock so the two locks cannot drift apart on the one question
 * where drifting is fatal ("may this file be deleted?"). This module fixes the
 * two windows that are specific to the claims registry and exposes the seam the
 * suite drives: `sweepStaleLock(file, { now, aliveOf })`.
 *
 * #1640 is why this is a call into a shared leaf rather than a `readFile` +
 * `rm` pair here. The pair was the bug: an async read straddling another
 * process's unlink+create (the read's fd pins the OLD inode, so its bytes reach
 * the caller after the path has been re-created by a new holder), then an
 * UNCONDITIONAL `fs.rm` by path deleting whatever the path held. Measured, 8
 * children released from a barrier, one run in ~30: waiter 16688's read
 * returned dead child 16682's token 4 ms after 16682's lock had been replaced
 * (16683 created at +1 ms, 16684 at +4 ms); 16688's `fs.rm` then unlinked
 * 16684's live lock. 16684 and 16688 held the "lock" simultaneously, both read
 * the same snapshot, and 16684's rename dropped 16688's just-published claim.
 * The fingerprint was 16684's release finding its own token gone (`holds=false`)
 * while it had never lost ownership.
 *
 * So: do not reintroduce a read + rm pair for the STALE SWEEP. The release path
 * still reads the token before unlinking it — that is a compare-and-delete on
 * OUR OWN lock, identified by a nonce only we hold, and it warns when the
 * comparison fails. That pair is correct, and is not what this sentence forbids.
 */

import {
  type HolderRead,
  LOCK_HARD_STALE_MULTIPLIER,
  sweepStaleLockfile,
} from "./stale-lock-sweep.ts";

/**
 * A lock whose holder is older than this is a corpse (a killed process left
 * it behind). Far beyond any plausible hold, short enough that a crashed
 * cycle does not park the registry for the rest of the session.
 */
export const LOCK_STALE_MS = 60_000;

/**
 * The ceiling on the pid voucher's veto: past this age the lock is a corpse
 * regardless of what `kill(pid, 0)` answers.
 *
 * Without it the liveness probe is an availability hole. `processAlive` returns
 * true for a pid that was recycled onto another job, for a zombie whose parent
 * never reaped it, and for a SIGSTOPped process — and none of those can release
 * a lockfile. A claim write holds this lock for milliseconds, so anything still
 * standing at 5× the stale window is not a holder.
 */
export const LOCK_HARD_STALE_MS = LOCK_STALE_MS * LOCK_HARD_STALE_MULTIPLIER;

/** What the waiter learned about the current holder — the shared verdict. */
export type { HolderRead };

export interface SweepSeams {
  /** Injected clock — a test ages a lock instead of sleeping for it. */
  now?: () => number;
  /** Injected liveness probe — a test drives the recycled-pid case. */
  aliveOf?: (pid: number) => boolean;
}

/**
 * Read the lockfile and judge its holder — and when it IS provably a corpse,
 * delete exactly that corpse, in one event-loop turn.
 *
 * The rules, and why each one is asymmetric toward waiting, are in
 * `stale-lock-sweep.ts`. The shape the suite pins through these seams:
 *
 *   - a provably dead holder's lock is swept immediately, so a killed process
 *     cannot pin the registry for the whole stale window;
 *   - a live holder is never swept, no matter how old — until the hard ceiling;
 *   - past the hard ceiling the age convicts alone, and the sweep warns;
 *   - a lock we cannot read, cannot parse, cannot place in time, or is not a
 *     regular file at all is WAITED OUT, never deleted.
 */
export function sweepStaleLock(file: string, seams: SweepSeams = {}): HolderRead {
  return sweepStaleLockfile(file, {
    staleMs: LOCK_STALE_MS,
    hardStaleMs: LOCK_HARD_STALE_MS,
    now: seams.now,
    aliveOf: seams.aliveOf,
  });
}
