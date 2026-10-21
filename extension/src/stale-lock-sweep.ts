/**
 * stale-lock-sweep — the one judge-and-delete for every `O_EXCL` lockfile this
 * extension leaves behind.
 *
 * Two locks had the same shape and the same bug: an async read of the holder
 * token straddling an unlink+create by another process, then an UNCONDITIONAL
 * `rm` by path. #1640 measured what that costs — a waiter's read returned a
 * dead child's token 4 ms after that child's lock had been replaced by a live
 * one, and its `rm` by path deleted the live holder's lock. Two writers in the
 * critical section at once, one claim lost, and the only fingerprint was the
 * victim's release finding its own token gone.
 *
 * Both callers now come through here, and the rule this module enforces is
 * that **judging and deleting are one operation**: every observation and the
 * unlink run in a single event-loop turn, and the unlink fires only after the
 * file at the path is re-validated to be the same inode, the same size, and
 * byte-for-byte the content that was judged. There is deliberately no exported
 * "read the lock age" primitive, because a caller that reads here and deletes
 * over there reproduces the bug this replaced.
 *
 * # Synchronous by contract
 *
 * This module contains no pause point and does not import the promises view of
 * the filesystem. `test-stale-lock-sweep.ts` asserts it. A future edit that
 * makes any part of this path pausable puts a scheduling gap between the
 * re-validation and the `unlinkSync`, which is the exact hole the re-validation
 * exists to close — the check would then describe a file that is no longer
 * there by the time the delete lands.
 *
 * # What each verdict means to the caller
 *
 *   - `stale`      — this module deleted the file. Retry the create.
 *   - `alive`      — wait. Includes a lock that is not a regular file and a
 *                    lock too large to read: neither is a token anyone can
 *                    judge, and neither is safe to delete.
 *   - `unreadable` — wait, nothing deleted. A token that PARSED but whose `at`
 *                    sits outside its domain lives here and is NEVER deleted by
 *                    either lock: "we cannot make sense of it" is not evidence
 *                    of death.
 *
 * `unreadableIsStale` is the one per-lock difference and it is an option, not a
 * fork. The claims lock (fail-closed: an unreadable lock is waited out) leaves
 * it off. The integration lock documents itself as fail-open and its suite pins
 * "an unparseable lockfile is treated as stale, not as a deadlock", so it opts
 * in — and even then the delete goes through the same revalidated path, gated
 * on the file's mtime having aged past a publish grace, so a lock a sibling
 * created a moment ago and has not published into yet is waited out rather than
 * stolen.
 *
 * # Bounds are checked before the read, not after
 *
 * A lock path that is a FIFO would block a read indefinitely, and a
 * multi-gigabyte file would be paid for in full before anything was judged.
 * Both are rejected from the `statSync` alone, which is why the size and file
 * type checks sit immediately after it.
 *
 * # The window is narrowed, not closed
 *
 * Between the final re-validation and the `unlinkSync` there remains a
 * check-to-unlink gap. It is no longer a *scheduled* gap — nothing in this
 * module pauses, so no other task in this process can be inserted there — but
 * another PROCESS can still unlink and re-create the path in the microseconds
 * around the syscall, and `unlinkSync` deletes by path. It cannot be closed
 * from user space with these primitives. What makes it survivable is the
 * release side: a holder whose token has vanished from a lock it acquired warns
 * loudly (`claims-lock: releasing without ownership`), so the theft
 * fingerprints itself instead of surfacing weeks later as a lost claim.
 */

import { type Stats, readFileSync, statSync, unlinkSync } from "node:fs";
import { processAlive } from "./process-liveness.ts";
import { traceWarn } from "./trace.ts";

/**
 * A lock this much older than its own stale window is a corpse whatever its
 * pid answers. The liveness probe says yes to a recycled pid, to a zombie
 * whose parent never reaped it, and to a SIGSTOPped process — and none of
 * those can release a lockfile. Holders of both locks measured here keep them
 * for milliseconds to minutes, so a multiplier of 5 over the stale window sits
 * orders of magnitude beyond any real hold.
 */
export const LOCK_HARD_STALE_MULTIPLIER = 5;

/**
 * A lockfile bigger than this is not a token. Both tokens are a pid, a
 * timestamp and (for the claims lock) a UUID nonce — well under 200 bytes.
 * Anything past 4 KB is an accident or an attack, and reading it is the cost
 * this bound refuses to pay.
 */
const MAX_LOCK_BYTES = 4096;

/**
 * Tolerance for a token stamped slightly in the future — a host whose clock
 * runs a few seconds fast, or a `now` read a hair before the write landed.
 * Past this the token is not trusted, because trusting it would mean computing
 * an age from a number the file itself asserted.
 */
const CLOCK_SKEW_MS = 5_000;

/**
 * How long an unpublishable lockfile is exempt from the `unreadableIsStale`
 * sweep. Creating the file and writing its token are adjacent syscalls, so a
 * lock younger than this may simply be mid-publication, and deleting it would
 * be the theft this module exists to prevent.
 */
const PUBLISH_GRACE_MS = 1_000;

/** What the sweep learned, and what the caller should do next. */
export type HolderRead =
  /** This module deleted the file. Retry the exclusive create. */
  | { status: "stale"; ageMs: number; pid: number | null }
  /** Wait. The holder is live, or the file is not judgeable and not deletable. */
  | { status: "alive" }
  /** Wait. Nothing was deleted: the token could not be read or made no sense. */
  | { status: "unreadable" };

/** Injected liveness probe — `processAlive` answers this in production. */
export type AliveOf = (pid: number) => boolean;

export interface SweepOptions {
  /**
   * The stale window for this lock: how long a hold of this resource is
   * expected to stay inside. Nothing is deleted below it unless the holder is
   * PROVABLY gone, and it is the window the hard ceiling is a multiple of.
   */
  staleMs: number;
  /** Age past which the lock is swept whatever its pid says. Defaults to 5×. */
  hardStaleMs?: number;
  /** Injected clock, so a test can age a lock instead of sleeping. */
  now?: () => number;
  /** Injected liveness probe, so a test can drive the recycled-pid case. */
  aliveOf?: AliveOf;
  /**
   * The integration lock's fail-open contract: an unpublishable lockfile is
   * swept rather than deadlocking consolidation. Off by default — the claims
   * lock must never delete a lock it cannot read.
   */
  unreadableIsStale?: boolean;
}

/** How the bytes at the lock path classify. */
type TokenRead =
  | { kind: "token"; at: number; pid: number | null }
  /** No JSON object at all: never judged, and only ever swept by opt-in. */
  | { kind: "no-token" }
  /** A JSON object whose `at` is outside its domain: never swept by anyone. */
  | { kind: "bad-at" };

/**
 * Is the holder PROVABLY gone?
 *
 * `null` (no usable pid in the token) answers false: absence of evidence of
 * death is not evidence of death, and that reading is what keeps a lock whose
 * token lost its `pid` field from being unlinked on age alone. Our own pid
 * answers false too — if we are holding it we are not a corpse.
 */
function holderIsDead(pid: number | null, aliveOf: AliveOf): boolean {
  if (pid === null || pid === process.pid) return false;
  return !aliveOf(pid);
}

/**
 * Classify the bytes. Every shape that is not a token is named, because the
 * two non-token shapes get OPPOSITE treatment: an absent token may be swept by
 * a lock that opted into `unreadableIsStale`, while a token that parsed and
 * then made no sense is never swept by anyone.
 */
function classify(raw: string, now: number): TokenRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "no-token" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "no-token" };
  }
  const entry = parsed as { at?: unknown; pid?: unknown };
  const at = entry.at;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return { kind: "bad-at" };
  if (at > now + CLOCK_SKEW_MS) return { kind: "bad-at" };
  const pid = typeof entry.pid === "number" && Number.isFinite(entry.pid) ? entry.pid : null;
  return { kind: "token", at, pid };
}

/**
 * Judge the lock at `file`, and delete it when — and only when — it is provably
 * a corpse. See the module header for the verdict contract.
 */
export function sweepStaleLockfile(file: string, opts: SweepOptions): HolderRead {
  const now = (opts.now ?? Date.now)();
  const aliveOf = opts.aliveOf ?? processAlive;
  const hardStaleMs = opts.hardStaleMs ?? opts.staleMs * LOCK_HARD_STALE_MULTIPLIER;

  let first: Stats;
  try {
    first = statSync(file);
  } catch {
    // Gone between our failed create and here — ordinary contention, and the
    // one shape that must NOT be read as a fault: a lock a sibling released a
    // moment ago reports ENOENT exactly like one that was never created.
    return { status: "alive" };
  }
  // Bounds before the read: a FIFO would block us and a huge file would be
  // paid for in full. Neither is a token, and neither is safe to delete.
  if (!first.isFile() || first.size > MAX_LOCK_BYTES) return { status: "alive" };

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // Readable enough to stat, not to read: treat as no token rather than
    // trusting a size we already saw.
    return judgeNoToken(file, first, null, now, opts);
  }
  const token = classify(raw, now);
  if (token.kind === "bad-at") return { status: "unreadable" };
  if (token.kind === "no-token") return judgeNoToken(file, first, raw, now, opts);

  const ageMs = now - token.at;
  const dead = holderIsDead(token.pid, aliveOf);
  const pastHardCeiling = ageMs > hardStaleMs;
  // Below the hard ceiling a live — or merely unidentifiable — holder is
  // waited out. Past it the age alone convicts, because the only things that
  // still answer `alive` at 5× the stale window are a recycled pid, a zombie,
  // or a stopped process, and none of them releases anything.
  if (!pastHardCeiling && !dead) return { status: "alive" };

  const stillCorpse = () => holderIsDead(token.pid, aliveOf) || pastHardCeiling;
  if (!deleteIfStillThere(file, first, raw, stillCorpse)) {
    return { status: "alive" };
  }
  if (pastHardCeiling && !dead) {
    const who =
      token.pid === null
        ? "names no pid at all"
        : `pid ${String(token.pid)} still answers kill(pid, 0)`;
    traceWarn(
      `stale-lock: swept a ${ageMs}ms-old lockfile past the ${hardStaleMs}ms hard ceiling — its holder ${who}, and at this age a lock is a corpse whether the pid was recycled, zombied, stopped, or simply never written`,
    );
  }
  return { status: "stale", ageMs, pid: token.pid };
}

/**
 * The no-token branch: nothing in this file can be trusted as a holder.
 *
 * Both locks wait unless they opted into `unreadableIsStale`, and even the
 * opt-in refuses to delete a file too young to have finished being published.
 * A token that PARSED but whose `at` was out of domain never reaches here — it
 * is reported `unreadable` with the sweep option ignored, because a
 * well-formed object carrying a nonsense timestamp is not evidence of death.
 */
function judgeNoToken(
  file: string,
  first: Stats,
  raw: string | null,
  now: number,
  opts: SweepOptions,
): HolderRead {
  if (!opts.unreadableIsStale) return { status: "unreadable" };
  // A token we could not parse has no `at` to age by, so the filesystem's own
  // record of when the file appeared is the only clock available.
  const ageMs = now - first.mtimeMs;
  if (ageMs < PUBLISH_GRACE_MS) return { status: "alive" };
  if (!deleteIfStillThere(file, first, raw, () => true)) return { status: "unreadable" };
  traceWarn(
    `stale-lock: swept an unreadable ${ageMs}ms-old lockfile (no parsable token; pid ${
      raw === null ? "unreadable" : "unknown"
    })`,
  );
  return { status: "stale", ageMs, pid: null };
}

/**
 * The delete half of the one operation: re-validate immediately before the
 * unlink that the path still holds the inode, the size and the exact bytes that
 * were judged, then remove it.
 *
 * `stillCorrupt` is re-consulted at the last moment — the same predicate that
 * convicted the holder, re-run against the same evidence — so a caller cannot
 * reach the unlink holding a verdict it no longer stands behind. Any mismatch
 * returns false: waiting is the conservative direction, and the next poll
 * decides again.
 *
 * The gap between the re-validation and the unlink is documented in the module
 * header — narrowed to a single syscall boundary with nothing scheduled inside
 * it, not closed, and fingerprinted by the release-side ownership warning.
 */
function deleteIfStillThere(
  file: string,
  first: Stats,
  raw: string | null,
  stillCorrupt: () => boolean,
): boolean {
  try {
    const last = statSync(file);
    if (last.ino !== first.ino || last.size !== first.size) return false;
    if (raw !== null && readFileSync(file, "utf8") !== raw) return false;
    if (!stillCorrupt()) return false;
    unlinkSync(file);
    return true;
  } catch {
    // Gone already (a sibling's verified sweep won) or unreadable again
    // mid-check: not our loss to explain, and not our file to delete.
    return false;
  }
}
