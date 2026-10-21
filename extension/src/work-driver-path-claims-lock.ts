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
 *
 * #1640 — the stale-holder judgment and the delete that removes a corpse are
 * ONE synchronous operation, reached through
 * `work-driver-path-claims-lock-sweep.ts` (`sweepStaleLock`) and implemented in
 * the shared leaf `stale-lock-sweep.ts`, re-validated by inode and bytes
 * immediately before the unlink. They used to be an async `readFile` here plus
 * an unconditional `fs.rm` by path, and under an 8-way fan-out that let a
 * waiter delete a LIVE holder's lock (the read straddled the path's
 * unlink+create) — two writers in the body at once, one claim lost. Do not
 * reintroduce a read + rm pair for the STALE SWEEP. (Release compares our own
 * nonce-identified token before unlinking, and warns when that comparison
 * fails; that is a different, correct pair.)
 */

import { randomUUID } from "node:crypto";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { trace, traceWarn } from "./trace.ts";
import { LOCK_HARD_STALE_MS, sweepStaleLock } from "./work-driver-path-claims-lock-sweep.ts";
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
 *
 * `withClaimsLock` takes an injectable `waitMs` for the same reason as
 * `acquireLedgerLock` does: a suite that waits out the real window twice pays
 * 2 × LOCK_WAIT_MS for an assertion about *what* the waiter did, not *how long*
 * it waited. Production callers pass nothing and keep the real window.
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
 * Every refusal `withClaimsLock` raises starts with this exact prefix, and
 * `checkAndRegisterClaims` discriminates on it (not on prose) to turn a
 * fail-closed registration into a NAMED cap-hit rather than a
 * `driver-crash:plan`. A reworded message therefore cannot silently turn the
 * named park back into an unhandled crash — the prefix is the contract, and
 * the two distinct bodies after it are what the operator reads.
 */
export const CLAIMS_LOCK_REFUSAL = "path-claims: refusing to register a claim without the lock";

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
 * ACCEPTED test seam (the shape `setLedgerCriticalSectionHookForTests` is):
 * throws between a SUCCESSFUL `openSync('wx')` and the write that publishes the
 * token. Never set in production — it stays `undefined` there, so the create
 * path costs one `undefined` check.
 *
 * It exists because the half-created lockfile is otherwise untestable, and it
 * is a real fault, not a hypothetical: `O_EXCL` makes the file exist, and a
 * `writeFileSync` that then throws (ENOSPC, a signal-interrupted fd) leaves an
 * EMPTY file behind that is not ours to reclaim by age — `sweepStaleLock` refuses
 * to call an unparsable lockfile stale. Every sibling then waits the full
 * `LOCK_WAIT_MS` on a file whose owner is gone, for as long as the corpse
 * stands. `acquire` closes the fd and unlinks what it created in that case.
 */
let writeFaultHook: (() => void) | undefined;

/** Permanent test seam (accepted): set/clear the post-create write fault. */
export function setClaimsLockWriteFaultForTests(fn?: () => void): void {
  writeFaultHook = fn;
}

/**
 * How long to wait for a holder before giving up. Generous against the work
 * it guards: a claim write is a small JSON file, so a holder is gone in
 * milliseconds — the window only has to cover a slow filesystem.
 */
const LOCK_WAIT_MS = 5_000;

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

/**
 * Ceiling on the poll's doubling backoff.
 *
 * A contended claim is normally handed over in milliseconds, so the first few
 * polls at 0.5 ms are what win the race; the backoff only ever gets paid on the
 * rare wait behind a holder that is slow or sick, and there 20 ms is responsive
 * enough while keeping a full `LOCK_WAIT_MS` spin to a few hundred syscalls
 * instead of ten thousand.
 */
const LOCK_RETRY_MAX_MS = 20;

function lockPath(repoRoot: string): string {
  return path.join(workStateDir(repoRoot), LOCK_FILE);
}

/**
 * Read the lockfile's contents, or null when there is nothing to read.
 *
 * `null` is kept distinct from a token that merely DIFFERS, because the two
 * mean different things to an operator: "someone else's token is here" is a
 * theft, while "nothing is here" is a release that raced a sweep.
 */
async function readLockfile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** The pid a lockfile token names, for the theft warning an operator reads. */
function tokenPid(raw: string): number | "unknown" {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isFinite(pid) ? pid : "unknown";
  } catch {
    return "unknown";
  }
}

/** Outcome of an acquisition attempt. */
interface LockHandle {
  /** The token this acquisition published, or null when it never got the lock. */
  token: string | null;
  release: () => Promise<void>;
  /**
   * What this acquisition actually is — ONE discriminant, because the two
   * booleans it replaces could be set together (`degraded && fault`), which is
   * the state where a caller has to guess which half of the contract applies.
   *
   *   - `held`                — we own the lockfile; the body is serialised.
   *   - `injected-unlocked`   — the test forced the lock off. A writer runs the
   *                             body WITHOUT serialisation, loudly, because the
   *                             mutation arm exists to reproduce the lost update
   *                             this module removes. No production cycle reaches
   *                             it: the env var is set by no caller in `src/`.
   *   - `fault`               — the lockfile could not be CREATED for a real
   *                             reason (read-only `.pi`, ENOSPC). A writer
   *                             refuses; it is not licensed to write unlocked.
   */
  state: "held" | "injected-unlocked" | "fault";
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
  let pollMs = LOCK_RETRY_MS;
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
      // That window is the third way this lock can be bypassed. It is NOT the
      // only thing standing between a half-published lock and two writers in
      // the body at once: `sweepStaleLock` refusing to call an unparsable lockfile
      // stale is load-bearing on its own, and it is what §2 of
      // `test-work-driver-claims-lock-publish.ts` pins (a waiter waits on a
      // zero-byte lock, it does not delete it). What the sync publish buys is
      // independence from that rule: a waiter should never be held off by a
      // lockfile nobody published, and any future change that makes an
      // unparsable read deletable (the pre-r2 behaviour, which really did steal
      // live locks) would turn the same window into two writers in the body at
      // once. Publishing synchronously removes the window rather than relying
      // on a runtime behaviour no caller can see.
      //
      // `openSync` + `writeFileSync(fd, …)` has no such seam: the create
      // returns and the write through the fd happens with no `await` and no
      // yield between them, so no other process can observe the file without
      // its token. This is the shape `review-ledger-lock.ts` already uses,
      // which is why that lock has never shown it. `writeSync` is not on bun's
      // `FileHandle`; `writeFileSync(fd, …)` is the documented way to write
      // through a numeric fd. The `catch` below owns the descriptor and the
      // file if the write itself throws — a create that succeeds and a publish
      // that does not is the OTHER half-created lock, and leaving it behind
      // pins every sibling for the whole wait window.
      //
      // The forced fault is decided BEFORE anything is created: the injected
      // branch never creates a file, so the token it would have published is
      // built, nonce-allocated and thrown away for nothing.
      if (unlocked) throwCannotCreate();
      const fd = openSync(file, "wx");
      try {
        writeFaultHook?.();
        writeFileSync(fd, token);
      } catch (writeErr) {
        // The file EXISTS (the create succeeded) and holds nothing but
        // whatever got through before the throw. Two facts follow, and both
        // are ours to clean up: a sibling cannot judge this lock stale (the
        // token is unparsable, and `sweepStaleLock` correctly refuses to call an
        // unparsable lock a corpse), so every waiter pays the full wait window
        // for a holder that is not one; and the fd we opened is still open.
        // Close it and remove the file WE created, then report the fault —
        // half a lock is worse than no lock.
        try {
          closeSync(fd);
        } catch {
          // Already closed by the write path, or closed twice: nothing to do.
        }
        try {
          unlinkSync(file);
        } catch {
          // Gone already (another waiter swept it). Nothing of ours left.
        }
        throw writeErr;
      }
      closeSync(fd);
      return {
        token,
        release: async () => {
          // Remove only our own lock — never another holder's. `token` is
          // unique per acquisition (nonce), so a lock a sibling swept and
          // re-took can never be unlinked by us.
          const current = await readLockfile(file);
          if (current === token) {
            await fs.rm(file, { force: true }).catch(() => undefined);
            return;
          }
          // #1640 — never silent: our token is gone from a lock WE acquired.
          // The two shapes say different things and the operator reading the
          // trace needs the difference: a token that DIFFERS means our lock was
          // unlinked and another process took the path while we held it, which
          // is the theft fingerprint; nothing to read at all means the path was
          // removed under us (a sweep that judged our live lock a corpse, or a
          // sibling's cleanup) with no replacement in sight. Both name the file
          // and the pid that now owns it, because the trace line is what gets
          // pasted into an issue.
          traceWarn(
            `claims-lock: releasing without ownership — ${path.basename(file)} ${
              current === null
                ? "could not be read (removed while we held it)"
                : `holds a different token (pid ${String(tokenPid(current))})`
            }; pid ${String(process.pid)} believed it held this lock (a live lock was stolen)`,
          );
        },
        state: "held",
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Cannot create the lock at all (read-only `.pi`, ENOSPC, the injected
        // fault), or we created it and the publish threw — in which case the
        // half-created file is already unlinked above. This is NOT a hand-off:
        // the caller must decide, because a writer that proceeds here is the
        // lost update this lock exists to remove. `unlocked` distinguishes the
        // test's forced fault (which the mutation arm needs to observe a real
        // lost update) from a genuine filesystem fault, and both are traced — a
        // registration that ran unserialised is never silent.
        //
        // `err.code` only, never the message: the message carries the absolute
        // lockfile path, and traces land in artifacts an operator shares.
        traceWarn(
          `claims-lock: lockfile could not be created (code ${
            (err as NodeJS.ErrnoException).code ?? "unknown"
          }) — ${
            unlocked
              ? "registering WITHOUT the lock (injected fault)"
              : "refusing to register unserialised"
          }`,
        );
        return {
          token: null,
          release: async () => undefined,
          state: unlocked ? "injected-unlocked" : "fault",
        };
      }
      // Held, or the lock could not be read. Sweep only once the HOLDER is
      // provably stale; anything else is waited out. Sweeping on a failed
      // parse is what destroyed live locks: a zero-byte or partial read is
      // more often "the holder is mid-publish" than "the holder is a corpse".
      //
      // A path that cannot be read at all — including one that is not a file —
      // is deliberately still waited out here, and NOT routed to "the lockfile
      // cannot be created". That looks like the obvious improvement (the
      // EISDIR case otherwise spins the window and then says "held by another
      // cycle") and it is a trap: `statSync` on a lock path a sibling released
      // a moment ago reports ENOENT like any absent file, so any "not a
      // regular file" test built on stat fires on ORDINARY contention. Measured
      // — under the 8-way fan-out that version faulted writers that were
      // merely polling, which is a fail-closed false alarm in the path every
      // real cycle takes. An unwritable `.pi/work-state` is still reported
      // faithfully: it fails the `wx` create with EACCES/EROFS/ENOSPC and the
      // catch above names the code.
      const holder = sweepStaleLock(file);
      if (holder.status === "stale") {
        trace(
          `claims-lock: swept a ${holder.ageMs}ms-old lockfile (holder pid ${holder.pid ?? "unknown"})`,
        );
        continue;
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, pollMs));
      // First hand-offs are decided in the first few sub-millisecond polls; the
      // doubling only matters for a wait that has already outlived them, and it
      // stops at LOCK_RETRY_MAX_MS so a sick holder cannot turn the wait into
      // ten thousand stat+read pairs.
      pollMs = Math.min(pollMs * 2, LOCK_RETRY_MAX_MS);
    }
  }
}

/**
 * Run `fn` holding the claims lock, throwing if the lock is not obtained
 * within the wait window OR the lockfile could not be created for a real
 * reason. For writers whose unlocked run would be a lost update: registration.
 *
 * registerClaim must NEVER write without holding the lock. Both ways of failing
 * to hold it — another cycle held the lock past the wait window, or the
 * lockfile could not be created at all (read-only `.pi`, ENOSPC), which is
 * `fault` and never the test's `injected-unlocked` — are traced before the
 * throw. The test's injected fault is the one exception, and only because the
 * mutation arm exists to prove the positive assertion tests the lock — it
 * deliberately reproduces the lost update this throw prevents. A production
 * cycle sets neither variable and cannot reach it.
 */
export async function withClaimsLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const handle = await acquire(repoRoot, Date.now() + waitMs);
  if (handle === null) {
    throw new Error(
      `${CLAIMS_LOCK_REFUSAL} — held by another cycle for over ${waitMs}ms; a lock whose holder pid is gone is swept at once, and one whose holder still answers is swept only past ${LOCK_HARD_STALE_MS}ms — no claim write holds this lock that long`,
    );
  }
  if (handle.state === "fault") {
    // A genuine "cannot create the lockfile" is not a licence to write
    // unserialised — that is the lost update with extra steps. Distinct text
    // from the busy case above: "wait longer" is the wrong advice when the
    // directory itself is the problem.
    throw new Error(
      `${CLAIMS_LOCK_REFUSAL} — the lockfile cannot be created; check that .pi/work-state is writable`,
    );
  }
  if (handle.state === "injected-unlocked") {
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
  opts: { waitMs?: number } = {},
): Promise<T> {
  const handle = await acquire(repoRoot, Date.now() + (opts.waitMs ?? LOCK_WAIT_MS));
  if (handle === null || handle.state !== "held") {
    trace("claims-lock: busy — skipping a best-effort claims write");
    return skip;
  }
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
