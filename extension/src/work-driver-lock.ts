/**
 * work-driver-lock — the integration lock (extracted from
 * work-driver-integrate.ts by #794 to keep that file under the 500-line
 * gate). The lock is the ONLY path that writes to repoRoot: it serialises
 * consolidation (cherry-pick / patch-apply) across workstreams AND across
 * concurrent driver processes in the same repo clone.
 *
 * Two layers, both required:
 *   - In-process: `integrationChain` promise chain (same-process serialisation).
 *   - Cross-process: an `O_EXCL` lockfile under `.git/` (`O_EXCL` — the
 *     create itself is the atomic test-and-set), swept when its holder has
 *     been gone for `LOCK_STALE_MS`.
 *
 * `acquireLockfile` fails OPEN on an unreadable / unwritable lock: the
 * in-process chain still serialises the current process, and a repo whose
 * `.git` is not writable is degraded enough that blocking hard on the lock
 * would cost more than the risk the lock guards against.
 *
 * #1740 — the stale-holder judgment is the shared leaf (`stale-lock-sweep.ts`),
 * the same one the claims lock uses, so the two cannot drift apart on whether a
 * given lockfile may be deleted. Two things that used to live here are gone:
 *
 *   - the read-then-`rm`: an `await fs.readFile` of the holder token followed by
 *     an UNCONDITIONAL `fs.rm(file, { force: true })`. The read could straddle
 *     another process's unlink+create (its fd pins the old inode, so its bytes
 *     arrive after the path is somebody else's), and the rm deleted by path
 *     whatever stood there — including a live holder's replacement lock. Now the
 *     judge and the delete are one synchronous operation that re-validates
 *     inode, size and bytes before unlinking.
 *   - the async publish (`fs.open('wx')` then an awaited `writeFile`), which
 *     left the lockfile observable at zero bytes for as long as the write took
 *     to resolve. The sweep's fail-open branch deletes an unpublishable lockfile
 *     once it has aged, so this lock had to stop producing them: the token is
 *     published with `openSync` + `writeFileSync(fd, …)`, in the same turn as
 *     the create. A publish that throws unlinks the file WE created before
 *     failing open, rather than leaving a corpse for the sweep to find.
 *
 * The one difference from the claims lock is passed as an option —
 * `unreadableIsStale`, this lock's documented fail-open contract that a corrupt
 * lockfile must not deadlock consolidation. The sweep still honours the publish
 * grace and the revalidation on that path, and it still refuses to delete on an
 * errno: a lock this process could not READ is waited out, never removed.
 *
 * Release carries the same fingerprint as the claims lock's: our token is read
 * ONCE and compared, and when it is gone from a lock we acquired the release
 * warns (basename, our pid, the pid that now holds the path) rather than
 * silently doing nothing. A token that vanished from under a live holder is the
 * theft signature the sweep cannot rule out from user space.
 */
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readTokenPid, sweepStaleLockfile, unlinkIfStillOurs } from "./stale-lock-sweep.ts";
import { trace, traceWarn } from "./trace.ts";

let integrationChain: Promise<unknown> = Promise.resolve();
/**
 * Lockfiles this process currently holds, mapped to the exact contents this
 * process wrote. A release removes a file only while it still holds that
 * content: a stale sweep may have handed the lock to another process.
 */
const heldLockfiles = new Map<string, string>();
/**
 * Paths that `releaseHeldIntegrationLocks` handed back on purpose.
 *
 * A signal exit calls that function while the critical section is still on the
 * stack, so the section's own `finally` runs a release for a lock the runner
 * already took back. Reporting that as a stolen live lock would cry wolf on the
 * one shape where the token going missing is exactly what we asked for — and a
 * warning that fires on normal shutdown is a warning nobody reads.
 */
const signalReleased = new Set<string>();
const LOCK_STALE_MS = 30 * 60 * 1000;
/** Poll between create attempts. Integration holds run minutes, not ms. */
const LOCK_RETRY_MS = 250;

function lockPath(repoRoot: string): string {
  return path.join(repoRoot, ".git", "pi-rukas-integration.lock");
}

/**
 * The lockfile's current contents, or `null` when nothing could be read.
 *
 * One read, one comparison, on the release path: `null` (absent or unreadable)
 * and "a different token" are reported differently in the theft warning because
 * they say different things — "removed under us" versus "someone else holds
 * this path now".
 */
async function readLockfile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * ACCEPTED test seam (the shape `setClaimsLockWriteFaultForTests` is): fires
 * between a SUCCESSFUL `openSync('wx')` and the write that publishes the token.
 * Never set in production — it stays `undefined` there, so the create path costs
 * one `undefined` check. It exists because the cleanup a failed publish runs is
 * otherwise unobservable: the inode guard only matters in the microseconds
 * between the failed write and the unlink, and nothing but a fault can put a
 * sibling's lock there.
 */
let writeFaultHook: (() => void) | undefined;

/** Permanent test seam (accepted): set/clear the post-create publish fault. */
export function setIntegrationLockWriteFaultForTests(fn?: () => void): void {
  writeFaultHook = fn;
}

/**
 * Publish the token through the fd we just created, in the create's own turn.
 *
 * A create that succeeds and a publish that throws leaves a file with no token
 * in it. Nobody can judge that file, the sweep's fail-open branch will not
 * delete it until it has aged past the publish grace, and every sibling pays
 * that wait for a holder that is not one — so the file we made is unlinked
 * before the fault is reported, and only while the path still holds it.
 */
function createAndPublish(file: string, token: string): void {
  const fd = openSync(file, "wx");
  try {
    writeFaultHook?.();
    writeFileSync(fd, token);
  } catch (writeErr) {
    // The fd we opened is the only proof of which file we made. Between the
    // failed write and here a sibling may have swept our tokenless file and
    // created ITS lock at the same path, and an unlink by path would then steal
    // a live holder's lock — the exact failure #1640 measured. So the cleanup
    // compares the path's inode against our fd's before removing anything.
    unlinkIfStillOurs(file, fd);
    throw writeErr;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed by the failing write — nothing of ours left to close.
    }
  }
}

async function acquireLockfile(repoRoot: string): Promise<() => Promise<void>> {
  const file = lockPath(repoRoot);
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      // `wx` is O_EXCL: the create itself is the atomic test-and-set, and
      // `createAndPublish` keeps the token's arrival indivisible from it.
      const token = JSON.stringify({ pid: process.pid, at: Date.now() });
      createAndPublish(file, token);
      heldLockfiles.set(file, token);
      return async () => {
        heldLockfiles.delete(file);
        // Remove only our own lock — never another holder's.
        const current = await readLockfile(file);
        if (current === token) {
          await fs.rm(file, { force: true }).catch(() => undefined);
          return;
        }
        if (signalReleased.delete(file)) return;
        // Never silent: our token is gone from a lock WE acquired. A token that
        // DIFFERS means our lock was unlinked and another process took the path
        // while we held it — the theft fingerprint, and the reason the sweep's
        // residual check-to-unlink gap is survivable. Nothing to read at all
        // means the path was removed under us (a sweep that judged our live
        // lock a corpse, or a sibling's cleanup) with no replacement in sight.
        traceWarn(
          `integration-lock: releasing without ownership — ${path.basename(file)} ${
            current === null
              ? "could not be read (removed while we held it)"
              : `holds a different token (pid ${String(readTokenPid(current) ?? "unknown")})`
          }; pid ${String(process.pid)} believed it held this lock (a live lock was stolen)`,
        );
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Cannot create the lock at all (read-only .git, permissions), or we
        // created it and the publish threw — in which case our own file is
        // already gone (removed by `createAndPublish`, inode-checked). Fail
        // OPEN: the in-process chain still serialises this process.
        trace(`integration-lock: lockfile unavailable, continuing: ${(err as Error).message}`);
        return async () => undefined;
      }
      // Held. One synchronous judge-and-delete decides whether it is a corpse.
      // Two options carry this lock's differences from the claims lock, and
      // both come from its fail-open contract:
      //
      //   - `unreadableIsStale` — a corrupt lockfile is swept rather than
      //     deadlocking consolidation (its suite pins exactly that). The sweep
      //     still refuses to touch one younger than the publish grace, so a
      //     sibling that created the path a moment ago is not robbed of it.
      //   - `hardStaleMs` = the stale window itself. Past 30 minutes a lock of
      //     this resource is a corpse whatever its pid answers, and that has to
      //     stay true: this waiter's own deadline is the same 30 minutes, after
      //     which it proceeds UNLOCKED. A pid that still answers at that age
      //     (recycled, zombied, SIGSTOPped) vetoing the sweep would therefore
      //     not protect a holder — it would trade a 30-minute stall for the
      //     exact two-consolidations-at-once corruption this lock exists to
      //     prevent. The claims lock, whose wait window is 5 s against a 60 s
      //     stale window, can afford the 5× ceiling; this one cannot.
      const verdict = sweepStaleLockfile(file, {
        staleMs: LOCK_STALE_MS,
        hardStaleMs: LOCK_STALE_MS,
        unreadableIsStale: true,
      });
      if (verdict.status === "stale") {
        trace(`integration-lock: swept a ${verdict.ageMs}ms-old lockfile`);
        continue;
      }
      if (Date.now() > deadline) {
        trace("integration-lock: waited past the stale window, proceeding");
        return async () => undefined;
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

/** Run `fn` holding the integration lock. Never inherits a prior rejection. */
export function withIntegrationLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const run = integrationChain.then(
    () => guarded(repoRoot, fn),
    () => guarded(repoRoot, fn),
  );
  integrationChain = run.catch(() => undefined);
  return run;
}

async function guarded<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLockfile(repoRoot);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Headless S4 (#1024) — remove every integration lockfile this process holds,
 * synchronously, so a signal exit leaves no lock for the next runner. A
 * `finally` does not run once `process.exit` is called, so the runner calls
 * this first. Safe to call when nothing is held.
 */
export function releaseHeldIntegrationLocks(): void {
  for (const [file, token] of heldLockfiles) {
    signalReleased.add(file);
    try {
      if (readFileSync(file, "utf8") === token) rmSync(file, { force: true });
    } catch {
      // Already gone, or unreadable: nothing of ours to remove.
    }
  }
  heldLockfiles.clear();
}

/** Test seam: reset the in-process chain between fixtures. */
export function __resetIntegrationLock(): void {
  integrationChain = Promise.resolve();
}
