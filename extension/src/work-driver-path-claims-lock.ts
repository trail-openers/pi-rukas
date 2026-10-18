/**
 * work-driver-path-claims-lock — the cross-process serialiser for the
 * path-claim registry.
 *
 * #1454 r2 — `readClaims` began WRITING (prune-on-read), which made every
 * reader a read-modify-write. Without a lock, two cycles interleaving
 * `read → prune → rename` each rebuilt the file from their own snapshot, so
 * the later `rename` silently dropped the earlier cycle's just-registered
 * claim. That is the failure the registry exists to prevent: two workstreams
 * editing one file, discovering it under `git apply`.
 *
 * The shape mirrors the integration lock in `work-driver-lock.ts` (O_EXCL is
 * the atomic test-and-set, stale-by-age recovery, release in `finally`) but is
 * deliberately NOT `withIntegrationLock`: that lock lives under `.git/` and
 * guards consolidation of a different resource, so its 30-minute stale window
 * would make the claims file unwaitable while any cycle consolidated. Separate
 * resource, separate lockfile, separate window.
 *
 * Two callers need opposite failure modes when the lock cannot be had, so
 * they are two functions rather than one with a flag:
 *
 *   - `withClaimsLockBestEffort` — for prune and release. Losing the lock
 *     costs a duplicate prune that the next reader repeats; it must never
 *     cost a cycle whose claim check is otherwise sound.
 *   - `withClaimsLock` — for registration. Proceeding unlocked is exactly the
 *     lost-update this module removes, so it throws and the caller decides.
 *     (A lockfile that cannot be CREATED at all — unwritable `.pi` — still
 *     runs the body: the alternative is a registry nobody can write.)
 *
 * The lockfile sits beside the data it guards (`.pi/work-state/path-claims.lock`)
 * rather than under `.git/` — same reason `path-claims.json` does.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { trace, traceWarn } from "./trace.ts";
import { processAlive } from "./work-driver-resume.ts";
import { workStateDir } from "./workflow-state.ts";

const LOCK_FILE = "path-claims.lock";

/**
 * True when the lock cannot be had at all — the injected fault the mutation
 * check drives, standing in for a read-only `.pi`.
 */
function lockForcedUnavailable(): boolean {
  return process.env.PI_ENSEMBLE_TEST_CLAIMS_LOCK_BLOCKED === "1";
}

/**
 * #1454 r2 — the injected width of a claim writer's read-modify-write window.
 *
 * The concurrent-writers test's mutation arm must observe a lost update with
 * the lock forced off. It is a genuine race — eight children released together
 * from a barrier — but whether any two of them land their `read` and `write`
 * on opposite sides of each other's rename is a scheduling question, and on a
 * fast, lightly-loaded runner they can clear the whole window without ever
 * overlapping. An assertion that only fails when the scheduler cooperates is a
 * mutation check that silently stops checking — which is what CI run
 * 39103184814 hit, where the arm reported `lost: []` and passed vacuously.
 *
 * So the arm widens the window this lock exists to make indivisible: this many
 * ms of `await` between the read and the write, so every writer is still
 * holding a snapshot a sibling's rename can land inside. It lives beside
 * `lockForcedUnavailable` because the two are one switch: the delay is read
 * ONLY when the lock is already forced off, so a production cycle — which sets
 * neither — never waits here, and the positive arm keeps asserting that a
 * SERIALISED writer loses nothing.
 */
export function resolveClaimsWindowMs(
  raw: string | undefined,
  lockBlocked: string | undefined,
): number {
  if (lockBlocked !== "1") return 0;
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export const CLAIMS_RMW_WINDOW_MS: number = resolveClaimsWindowMs(
  process.env.PI_ENSEMBLE_TEST_CLAIMS_WINDOW_MS,
  process.env.PI_ENSEMBLE_TEST_CLAIMS_LOCK_BLOCKED,
);

/**
 * Throw the same ENOENT an unwritable directory throws, so the fault-injection
 * path exercises the REAL "cannot create the lock" branch rather than a
 * bespoke one that could drift from it.
 */
function throwCannotCreate(): never {
  const err = new Error("injected: claims lockfile cannot be created") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  throw err;
}

/**
 * How long to wait for a holder before giving up. Generous against the work
 * it guards: a claim write is a small JSON file, so a holder is gone in
 * milliseconds — the window only has to cover a slow filesystem.
 */
const LOCK_WAIT_MS = 5_000;

/**
 * A lock whose holder is older than this is a corpse (a killed process left
 * it behind). Far beyond any plausible hold, short enough that a crashed
 * cycle does not park the registry for the rest of the session.
 */
const LOCK_STALE_MS = 60_000;

/**
 * Poll interval between acquisition attempts.
 *
 * Sub-millisecond, not the integration lock's 250ms. Measured: eight writers
 * contending at a 250ms poll lose entries even THOUGH each one holds the lock,
 * because release is `readFile → compare token → unlink` — three syscalls
 * across the very window the next waiter is about to open. A tight poll makes
 * that window small relative to the hold instead of comparable to it.
 */
const LOCK_RETRY_MS = 0.5;

function lockPath(repoRoot: string): string {
  return path.join(workStateDir(repoRoot), LOCK_FILE);
}

/** True when the lockfile still holds exactly `token` (this process's write). */
async function holdsLockfile(file: string, token: string): Promise<boolean> {
  try {
    return (await fs.readFile(file, "utf8")) === token;
  } catch {
    return false;
  }
}

/** What the waiter learned about the current holder. */
type HolderRead =
  | { status: "stale"; ageMs: number; pid: number | null }
  | { status: "alive" }
  | { status: "unreadable" };

/**
 * Read the lockfile and judge its holder WITHOUT destroying it.
 *
 * `stale` requires BOTH signals the name implies: the token parsed AND its
 * `at` timestamp sits past the stale window. Anything else — unreadable,
 * unparsable, zero-byte, an `at` we cannot parse — is `alive`, i.e. "wait".
 * That asymmetry is the whole point: the cost of waiting on a corpse is
 * bounded by the next poll and eventually by the deadline, while the cost of
 * deleting a live holder's lock is two writers in the body at once, which is
 * the exact lost update the lock exists to remove.
 *
 * A holder whose pid has exited is swept early: a killed process cannot
 * release, so its lock would otherwise pin the registry for the full stale
 * window across every concurrent cycle.
 */
async function readLockAge(file: string): Promise<HolderRead> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { status: "unreadable" };
  }
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
  if (ageMs > LOCK_STALE_MS) return { status: "stale", ageMs, pid };
  // A corpse's lock is stale immediately — but only when the token parsed, so
  // a half-published file is never judged by a field we could not read.
  if (pid !== null && pid !== process.pid && !processAlive(pid)) {
    return { status: "stale", ageMs, pid };
  }
  return { status: "alive" };
}

/** Outcome of an acquisition attempt. */
interface LockHandle {
  /** The token this acquisition published, or null when it never got the lock. */
  token: string | null;
  release: () => Promise<void>;
  /**
   * True when the body ran WITHOUT serialisation. A lockfile that cannot be
   * CREATED (read-only `.pi`) degrades to an unserialised write, which is the
   * pre-lock behaviour and the lesser cost; the injected fault is the same
   * shape and is what the mutation check observes.
   */
  degraded: boolean;
}

async function acquire(
  repoRoot: string,
  deadline: number,
  unlocked: boolean = lockForcedUnavailable(),
): Promise<LockHandle | null> {
  const file = lockPath(repoRoot);
  // The directory is created BEFORE the lock is attempted, not by the writer
  // that later happens to call `writeClaims`. An ENOENT here is otherwise
  // indistinguishable from a genuinely unwritable `.pi`, which sends the first
  // writer of a fresh project down the unserialised path — exactly when a
  // fan-out is most likely to be racing.
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
  for (;;) {
    try {
      // `wx` is O_EXCL: the create itself is the atomic test-and-set.
      const token = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: randomUUID() });
      // The create must publish the token, not merely the name. bun's
      // `open(path, "wx", mode, data)` silently ignores the data argument, so
      // the ONLY shape that publishes atomically is a same-tick burst with the
      // handle still open: bun's `FileHandle.writeFile` performs the write
      // synchronously before its first `await` (verified by observing the
      // on-disk bytes before the returned promise settles), so the file is
      // never observable as zero bytes. Awaiting between `open` and `write`
      // instead opens a window in which a sibling's poll reads "", fails
      // JSON.parse, and — reading that as corruption — DELETES a lock whose
      // holder is alive. That is the lost update the concurrency test caught.
      // `writeSync` is not on bun's FileHandle, so this is `writeFile` with the
      // `await` deliberately left to the caller's chain.
      const fh = unlocked ? throwCannotCreate() : await fs.open(file, "wx");
      const published = fh.writeFile(token);
      await published;
      await fh.close();
      return {
        token,
        release: async () => {
          // Remove only our own lock — never another holder's. `token` is
          // unique per acquisition (nonce), so a lock a sibling swept and
          // re-took can never be unlinked by us.
          if (await holdsLockfile(file, token)) {
            await fs.rm(file, { force: true }).catch(() => undefined);
          }
        },
        degraded: false,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Cannot create the lock at all (read-only .pi, or the injected
        // fault). The body still runs: a registry nobody can write is worse
        // than an unserialised write, and the atomic rename in writeClaims
        // still prevents a torn file.
        trace(`claims-lock: lockfile unavailable, continuing unlocked: ${(err as Error).message}`);
        return { token: null, release: async () => undefined, degraded: unlocked };
      }
      // Held. Sweep it only once the HOLDER is provably stale; anything else
      // we wait out. Sweeping on a failed parse is what destroyed live locks:
      // a zero-byte or partial read is more often "the holder is mid-publish"
      // than "the holder is a corpse", and deleting a live lock hands the
      // resource to a second writer while the first is still in its body.
      const holder = await readLockAge(file);
      if (holder.status === "stale") {
        trace(
          `claims-lock: sweeping a ${holder.ageMs}ms-old lockfile (holder pid ${holder.pid ?? "unknown"})`,
        );
        await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

/**
 * Run `fn` holding the claims lock, throwing if the lock is not obtained
 * within the wait window. For writers whose unlocked run would be a lost
 * update: registration.
 */
export async function withClaimsLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const handle = await acquire(repoRoot, Date.now() + LOCK_WAIT_MS);
  if (handle === null) {
    throw new Error(
      `path-claims: could not acquire the claims lock within ${LOCK_WAIT_MS}ms — ` +
        `another cycle holds ${lockPath(repoRoot)} (a stale lock is swept after ${LOCK_STALE_MS}ms)`,
    );
  }
  if (handle.degraded) {
    // A writer that could not serialise is exactly how a claim goes missing,
    // so it is never silent. It still runs (a registry nobody can write is
    // worse than an unserialised write) but the operator sees why claims may
    // disagree.
    traceWarn(
      "claims-lock: registering a path claim WITHOUT the lock — a concurrent cycle may overwrite it",
    );
  }
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

/**
 * Run `fn` holding the claims lock, or skip it entirely when the lock cannot
 * be obtained. For work that is best-effort by contract: the prune-on-read and
 * a release. Skipping costs a repeat of work the next reader does anyway.
 */
export async function withClaimsLockBestEffort<T>(
  repoRoot: string,
  fn: () => Promise<T>,
  skip: T,
): Promise<T> {
  const handle = await acquire(repoRoot, Date.now() + LOCK_WAIT_MS);
  if (handle === null) {
    trace("claims-lock: busy — skipping a best-effort claims write");
    return skip;
  }
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
