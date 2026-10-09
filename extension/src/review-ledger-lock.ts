/**
 * review-ledger-lock — the per-clone lock that serialises the ledger writer's
 * read → transform → rename window (the #1071 fix).
 *
 * `appendLedgerEntry` (review-ledger.ts) reads the ledger, dedupes, bumps the
 * round counter and rewrites the whole file. Two near-simultaneous writers on
 * one clone (an adversarial_loop finishing while a dispatch_lens_review
 * finishes, or two Pi sessions on the same clone) each read the PRE-rename
 * contents, so one writer's rename silently drops the other's row — a passing
 * review vanishes and the #912 merge guard refuses with "no passing … review
 * on file (latest: none)". This module is the lock that spans that window.
 *
 * The shape mirrors `acquireLockfile` (work-driver-lock.ts) — an `O_EXCL`
 * "wx" lockfile whose create is the atomic test-and-set, holding `{pid, at}` —
 * but with its OWN short windows, deliberately not sharing that 30-minute
 * stale window and 250 ms poll: the critical section is a few fs ops, so the
 * wait is ≈5 s (test-injectable) and the stale window is ≈30 s (test-
 * injectable). The lockfile is COLOCATED with the ledger file — named from the
 * RESOLVED ledger path (the `ledgerPathFor` output, honouring the
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` override) — so two test processes sharing
 * one override contend on the same lock, and the default (git-common-dir)
 * path gets a lock beside it.
 *
 * The contract is "never throws, never blocks long": any fault (an unreadable
 * lock, a non-EEXIST open error, a past-deadline wait) traces and returns a
 * NO-OP release, so the caller falls through to the existing unlocked
 * write + `mergeAfterRace` fallback. That degraded path preserves the other
 * writer's row (mergeAfterRace re-reads immediately before its rename), so a
 * lock failure costs at most a lost rename, never a blocked writer.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { trace } from "./trace.ts";

/** Default bounded wait before the degraded fall-through (≈5 s). */
export const LEDGER_LOCK_WAIT_MS = 5_000;
/** Default stale window before a lockfile is swept (≈30 s). */
export const LEDGER_LOCK_STALE_MS = 30_000;
/** Poll interval while waiting for a held lock to be released. */
const LEDGER_LOCK_POLL_MS = 50;

export interface LedgerLockOptions {
  /** Bounded wait before the degraded fall-through. Defaults to LEDGER_LOCK_WAIT_MS. */
  waitMs?: number;
  /** Stale window before a lockfile is swept. Defaults to LEDGER_LOCK_STALE_MS. */
  staleMs?: number;
  /** Poll interval while waiting. Defaults to 50 ms; tests may shorten it. */
  pollMs?: number;
  /** Injectable clock for deterministic stale-sweep tests. */
  now?: () => number;
}

/** The lockfile path, colocated with the ledger file (the resolved path, so
 * the `PI_ENSEMBLE_REVIEW_LEDGER_FILE` override's parent dir gets the lock). */
export function ledgerLockPath(ledgerFile: string): string {
  return `${ledgerFile}.lock`;
}

/**
 * #1071 — test-only hook: a delay injected between the critical section's
 * read and its rename, so a two-process race can straddle the read/rename
 * gap deterministically (see test-review-ledger-lock.ts). Production code
 * never sets this; it is read from the process env so a child process can
 * set it in its own env without importing the test file. The hook is
 * deliberately a no-op in production (env var absent → 0 ms).
 */
export function testDelayReadMs(): number {
  const v = process.env.PI_ENSEMBLE_REVIEW_LEDGER_DELAY_READ_MS;
  if (!v) return 0;
  const ms = Number(v);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** A bounded synchronous sleep (the test-only delay hook uses this). */
export function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    void Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Math.max(1, end - Date.now()),
    );
  }
}

/**
 * Acquire the review-ledger lock for the critical section spanning
 * read → dedupe → bumpLensRound → write-temp → rename. Returns a release
 * function. Never throws: every fault path traces and returns a no-op
 * release, so the caller degrades to the unlocked write + mergeAfterRace
 * fallback rather than blocking or surfacing an error.
 */
export function acquireLedgerLock(ledgerFile: string, opts: LedgerLockOptions = {}): () => void {
  const waitMs = opts.waitMs ?? LEDGER_LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LEDGER_LOCK_STALE_MS;
  const pollMs = opts.pollMs ?? LEDGER_LOCK_POLL_MS;
  const now = opts.now ?? Date.now;
  const lock = ledgerLockPath(ledgerFile);
  const deadline = now() + waitMs;
  let holder = `${process.pid}:${Date.now()}`;

  const noOpRelease = (): void => undefined;

  for (;;) {
    try {
      // `wx` is O_EXCL: the create is the atomic test-and-set. The lock
      // content is `{pid, at}` (the work-driver-lock.ts shape) plus a holder
      // token this process wrote, so release can verify ownership before it
      // removes (never deleting a successor's lock).
      holder = `${process.pid}:${Date.now()}`;
      const fh = openSync(lock, "wx");
      try {
        writeFileSync(fh, JSON.stringify({ pid: process.pid, at: now(), holder }));
      } finally {
        closeSync(fh);
      }
      return () => releaseIfOurs(lock, holder, now, staleMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Cannot create the lock at all (read-only dir, EACCES, ENOSPC).
        // Fail OPEN: the degraded write + mergeAfterRace preserves the other
        // writer's row, so the lock failure costs nothing the fallback does
        // not already guarantee.
        trace(`review-ledger-lock: lockfile unavailable, continuing: ${(err as Error).message}`);
        return noOpRelease;
      }
      // Held. Sweep it if the holder is stale (or unparseable), else wait.
      if (!sweepIfStale(lock, now, staleMs)) {
        if (now() >= deadline) {
          // Past the bounded wait. Degrade: the caller proceeds to the
          // unlocked write + mergeAfterRace fallback (traced; the fallback
          // re-reads before its rename, so the other writer's row survives).
          trace(
            `review-ledger-lock: waited past the bounded wait (${waitMs} ms), proceeding degraded`,
          );
          return noOpRelease;
        }
        sleep(pollMs);
      }
      // We swept a stale lock; retry the open (the sweep is best-effort —
      // another writer may have created a fresh lock since).
    }
  }
}

/**
 * Remove the lockfile only if it is still stale (or unparseable). Returns
 * true when a stale/unparseable lock was swept (caller should retry the
 * open). A fresh lock is left alone; a lock that vanished between the check
 * and the remove is a no-op. Never throws.
 */
function sweepIfStale(lock: string, now: () => number, staleMs: number): boolean {
  try {
    if (!existsSync(lock)) return false; // nothing to sweep; open will (re)create
    let parsed: { at?: unknown } | null = null;
    let unparseable = false;
    try {
      parsed = JSON.parse(readFileSync(lock, "utf8")) as { at?: unknown };
    } catch {
      unparseable = true;
    }
    const isStale =
      unparseable || typeof parsed?.at !== "number" || now() - (parsed?.at as number) > staleMs;
    if (!isStale) return false;
    trace("review-ledger-lock: sweeping a stale lockfile");
    try {
      unlinkSync(lock);
    } catch {
      // A successor created a fresh lock between the check and the unlink —
      // the unlink throws (or we removed a successor's; see the note below).
      // Best-effort: the open will either EEXIST (fresh lock held) or
      // succeed (lock gone).
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the lockfile only if it still holds THIS process's holder token.
 * A successor that swept a stale lock and created a fresh one is never
 * deleted (its `holder` differs). Never throws.
 */
function releaseIfOurs(lock: string, holder: string, now: () => number, staleMs: number): void {
  try {
    if (!existsSync(lock)) return;
    const raw = readFileSync(lock, "utf8");
    let parsed: { holder?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw) as { holder?: unknown };
    } catch {
      parsed = null;
    }
    if (parsed && parsed.holder === holder) {
      try {
        unlinkSync(lock);
      } catch {
        // Already gone (swept or released); nothing to do.
      }
      return;
    }
    // Not ours (a successor's lock). If it is fresh, leave it; if it is
    // stale, sweep it so the next acquire does not wait on a dead holder.
    if (parsed && typeof parsed.holder === "string" && parsed.holder !== holder) {
      if (sweepIfStale(lock, now, staleMs)) {
        // Swept; we hold nothing now, so do not attempt a second remove.
      }
      return;
    }
    // Unparseable (or no holder): treat as stale and sweep.
    sweepIfStale(lock, now, staleMs);
  } catch {
    // Never throws: a lock release failure must not surface to the caller.
  }
}

/** A bounded, interruptible-enough sleep (the poll between lock probes). */
function sleep(ms: number): void {
  // Synchronous poll; the critical section is short, so a busy-wait-free
  // synchronous sleep keeps the acquire path non-async (the caller is in an
  // async fn but the lock API is deliberately synchronous so it wraps a
  // synchronous critical section without threading a promise through it).
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // A plain spin is acceptable for a 50 ms poll; the alternative (Atomics
    // + SharedArrayBuffer) adds no value here and complicates the API.
    void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}
