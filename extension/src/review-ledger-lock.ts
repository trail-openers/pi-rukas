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

// #1071 test-only hook: a function appendLedgerEntry awaits between the
// ledger read and the rename (the widened critical section). Production code
// never sets it (undefined → no-op); only a spawned test child that imports
// this module and injects its own ~150 ms await sets it, which lets the
// two-process race (test-review-ledger-lock.ts) straddle the read/rename gap
// deterministically without an env-var read in the production write path.
let criticalSectionHook: (() => Promise<void> | void) | undefined;

/** Test-only: set the between-read/rename hook. `undefined` clears it. */
export function setLedgerCriticalSectionHookForTests(fn?: () => Promise<void> | void): void {
  criticalSectionHook = fn;
}

export async function runLedgerCriticalSectionHook(): Promise<void> {
  if (criticalSectionHook) await criticalSectionHook();
}

/** The lockfile path, colocated with the ledger file (the resolved path, so
 * the `PI_ENSEMBLE_REVIEW_LEDGER_FILE` override's parent dir gets the lock). */
export function ledgerLockPath(ledgerFile: string): string {
  return `${ledgerFile}.lock`;
}

/**
 * Acquire the review-ledger lock for the critical section spanning
 * read → dedupe → bumpLensRound → write-temp → rename. Returns a release
 * function. Never throws: every fault path traces and returns a no-op
 * release, so the caller degrades to the unlocked write + mergeAfterRace
 * fallback rather than blocking or surfacing an error.
 */
export async function acquireLedgerLock(
  ledgerFile: string,
  opts: LedgerLockOptions = {},
): Promise<() => void> {
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
      return () => releaseIfOurs(lock, holder);
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
        // Async wait (not Atomics.wait): a synchronous sleep here would stop
        // the whole process's event loop for the poll, starving timers and
        // I/O callbacks in every part of the process for the duration of a
        // contended acquire. An awaited setTimeout yields back to the loop
        // between polls, so the wait is bounded AND non-blocking.
        await new Promise((r) => setTimeout(r, pollMs));
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
function releaseIfOurs(lock: string, holder: string): void {
  try {
    if (!existsSync(lock)) return;
    const raw = readFileSync(lock, "utf8");
    let parsed: { holder?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw) as { holder?: unknown };
    } catch {
      parsed = null;
    }
    // Only remove the lock when its holder token is OURS. A successor that
    // swept a stale lock and created a fresh one is never deleted (its
    // `holder` differs); sweeping a stale lock is acquire's job.
    if (parsed && parsed.holder === holder) {
      try {
        unlinkSync(lock);
      } catch {
        // Already gone (swept or released); nothing to do.
      }
    }
  } catch {
    // Never throws: a lock release failure must not surface to the caller.
  }
}
