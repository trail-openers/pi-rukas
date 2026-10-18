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
import { closeSync, openSync, writeFileSync } from "node:fs";
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
   * True when the body ran WITHOUT serialisation.
   */
  degraded: boolean;
  /**
   * True when the lockfile could not be CREATED for a real reason (read-only
   * `.pi`, ENOSPC) rather than the test's injected fault. A genuine fault is
   * never silently degraded for a writer: `withClaimsLock` throws on it.
   */
  fault?: boolean;
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
      // The token must be published IN THE SAME TICK as the create.
      //
      // O_EXCL makes existence atomic; it says nothing about CONTENTS. Any
      // `await` between the create and the write splits them, and inside the
      // split a sibling sees a lockfile that exists and holds nothing — a lock
      // that is neither held nor free.
      //
      // The previous revision used the async shape (`await fs.open(file, "wx")`,
      // then `fh.writeFile(token)`) and asserted here that bun's
      // `FileHandle.writeFile` "performs the write synchronously before its
      // first `await`", so the file is "never observable as zero bytes". That
      // assertion is FALSE. Measured with an independent harness: 8 writers
      // released from a barrier while one observer polls the real lock path —
      // the async shape exposes 25,391 zero-byte reads across 6 rounds, the
      // sync shape 0. The bytes reach the inode only once the awaited write
      // resolves, so every poll landing between create and resolution sees an
      // empty file.
      //
      // That window is the third way this lock can be bypassed, and it is the
      // one the `readLockAge` contract silently depends on. The judge refuses
      // to call an unparsable lockfile stale — correctly, because a half-read
      // file is more often "mid-publish" than "corpse". But it also means a
      // waiter can be held off by a lockfile nobody published, and any future
      // change that makes an unparsable read deletable (the pre-r2 behaviour,
      // which really did steal live locks) turns the same window into two
      // writers in the body at once. Publishing synchronously removes the
      // window instead of relying on a runtime behaviour no caller can see.
      //
      // `openSync` + `writeFileSync(fd, …)` has no such seam: the create
      // returns and the write through the fd happens with no `await` and no
      // yield between them, so no other process can observe the file without
      // its token. This is the shape `review-ledger-lock.ts` already uses,
      // which is why that lock has never shown it. `writeSync` is not on bun's
      // `FileHandle`; `writeFileSync(fd, …)` is the documented way to write
      // through a numeric fd, and the `finally` guarantees the descriptor
      // closes even if the write throws.
      if (unlocked) throwCannotCreate();
      const fd = openSync(file, "wx");
      try {
        writeFileSync(fd, token);
      } finally {
        closeSync(fd);
      }
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
        // Cannot create the lock at all (read-only `.pi`, ENOSPC, the injected
        // fault). This is NOT a hand-off: the caller must decide, because a
        // writer that proceeds here is the lost update this lock exists to
        // remove. `unlocked` distinguishes the test's forced fault (which the
        // mutation arm needs to observe a real lost update) from a genuine
        // filesystem fault, and both are traced — a registration that ran
        // unserialised is never silent.
        traceWarn(
          `claims-lock: lockfile cannot be created (${(err as Error).message}) — ${
            unlocked
              ? "registering WITHOUT the lock (injected fault)"
              : "refusing to register unserialised"
          }`,
        );
        return { token: null, release: async () => undefined, degraded: true, fault: !unlocked };
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
 * within the wait window OR the lockfile could not be created for a real
 * reason. For writers whose unlocked run would be a lost update: registration.
 *
 * registerClaim must NEVER write without holding the lock. Both ways of failing
 * to hold it are fatal here and both are traced before the throw: another cycle
 * held the lock past the wait window, or the lockfile could not be created at
 * all (read-only `.pi`, ENOSPC). The test's injected fault is the one
 * exception, and only because the mutation arm exists to prove the positive
 * assertion tests the lock — it deliberately reproduces the lost update this
 * throw prevents. A production cycle sets neither variable and cannot reach it.
 */
export async function withClaimsLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const handle = await acquire(repoRoot, Date.now() + LOCK_WAIT_MS);
  if (handle === null) {
    throw new Error(
      `path-claims: refusing to register a claim without the lock — could not acquire ${lockPath(repoRoot)} within ${LOCK_WAIT_MS}ms (another cycle holds it; a stale lock is swept after ${LOCK_STALE_MS}ms)`,
    );
  }
  if (handle.fault) {
    // A genuine "cannot create the lockfile" is not a licence to write
    // unserialised — that is the lost update with extra steps.
    throw new Error(
      `path-claims: refusing to register a claim without the lock — ${lockPath(repoRoot)} cannot be created (check that .pi/work-state is writable)`,
    );
  }
  if (handle.degraded) {
    // Reached only under the injected fault. Still never silent.
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
