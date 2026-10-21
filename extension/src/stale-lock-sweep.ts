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
 * over there reproduces the bug this replaced. The one exported delete,
 * `unlinkIfStillOurs`, is not that shape: it takes the fd of the file the
 * caller CREATED and refuses to unlink a path that no longer resolves to it.
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
 *   - `alive`      — wait. Includes a lock that is not a regular file (nothing
 *                    here can unlink a directory, so waiting is the only
 *                    honest verdict) and a lock whose corpse is still too young
 *                    to have finished being published.
 *   - `unreadable` — wait, nothing deleted, with the `errno` when a read is
 *                    what failed. Carries every shape whose token could not be
 *                    judged: unreadable bytes, a nonsense `at`, an oversized
 *                    file.
 *
 * # The token is judged on its real domain
 *
 * `at` is a wall-clock timestamp, so the domain is a finite number between a
 * fixed floor (2020-01-01 — nothing this extension writes is older, and a
 * value below the floor is not a time anyone stamped) and `now` plus a small
 * clock-skew tolerance. `pid` is a positive integer. A token carrying
 * `at: 1`, `at: 0`, `pid: 1.5` or `pid: -1` is NOT a holder that has been
 * around since the epoch with a fractional process id: it is a token from a
 * program that wrote something else, and treating it as a timestamp turns a
 * nonsense value into an enormous age, which the hard ceiling would then
 * "prove" dead. Values outside the domain are `bad-at`/pid-less and never
 * become evidence of death on their own.
 *
 * # A read error is not a stale lock
 *
 * `EACCES`, `EIO`, `EAGAIN` — a file we could `stat` but not read has told us
 * nothing about its holder, and deleting it would be a delete decided on an
 * errno. Read errors NEVER delete, under either lock, even with
 * `unreadableIsStale` set. Only content that was actually read and failed to
 * parse is eligible for that option.
 *
 * `unreadableIsStale` is the one per-lock difference and it is an option, not a
 * fork. The claims lock (fail-closed: an unreadable lock is waited out) leaves
 * it off. The integration lock documents itself as fail-open and its suite
 * pins "an unparseable lockfile is treated as stale, not as a deadlock", so it
 * opts in — and even then every delete goes through the same revalidated path:
 *
 *   - a file that was read and did not PARSE is swept once its mtime is older
 *     than a publish grace (creating the file and writing its token are
 *     adjacent syscalls, so a younger one may simply be mid-publication);
 *   - every other shape we cannot judge is swept only past `hardStaleMs` by
 *     mtime — the same last resort the age rule is for a live pid, applied to
 *     a token that answers nothing at all.
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
 * loudly (`releasing without ownership`, from both locks), so the theft
 * fingerprints itself instead of surfacing weeks later as a lost claim.
 */

import { type Stats, fstatSync, readFileSync, statSync, unlinkSync } from "node:fs";
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
 * The floor of the `at` domain: 2020-01-01T00:00:00Z.
 *
 * Nothing this extension writes can be older than the extension, so anything
 * below this is not a timestamp — it is `1`, `0`, a sentinel, or a field from a
 * different schema. The distinction is not cosmetic: `now - 1` is an age of
 * ~54 years, which every ceiling in this module reports as "unambiguously
 * stale", so a nonsense number becomes a death sentence for a LIVE holder.
 */
const TOKEN_AT_FLOOR_MS = Date.UTC(2020, 0, 1);

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
  /** Wait. The holder is live, or the file is one nothing here may unlink. */
  | { status: "alive" }
  /**
   * Wait. Nothing was deleted: the token could not be read or made no sense.
   * `errno` is set when a READ failed, so the caller's trace names the errno
   * rather than implying the holder did something.
   */
  | { status: "unreadable"; errno?: string };

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
   * lock must never delete a lock it cannot read. Never applies to a read
   * ERROR, only to content that was read and could not be judged.
   */
  unreadableIsStale?: boolean;
}

/** How the bytes at the lock path classify. */
type TokenRead =
  | { kind: "token"; at: number; pid: number | null }
  /** No JSON object at all: swept by opt-in once past the publish grace. */
  | { kind: "no-token" }
  /** A JSON object whose `at` is outside its domain: judged by mtime only. */
  | { kind: "bad-at" };

/**
 * A pid that the OS could have issued: a positive integer. Anything else —
 * `1.5`, `0`, `-1`, `"4242"`, `NaN` — names no process, so it is no evidence
 * of either life or death. Collapsing it to `null` is what keeps a malformed
 * token out of the liveness probe, where `kill(1.5, 0)` throws EINVAL and an
 * injected probe may cheerfully answer "not alive".
 */
function pidOf(parsed: unknown): number | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const pid = (parsed as { pid?: unknown }).pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The pid a lockfile token names, or `null` when nothing in it names one.
 *
 * Exported because the release side of both locks needs the SAME reading of a
 * token as the sweep: an operator comparing a theft warning against the lock
 * file must not see `pid 1.5` in one and `pid unknown` in the other.
 */
export function readTokenPid(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pidOf(parsed);
}

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
 * shapes get DIFFERENT treatment: an absent token may be swept by a lock that
 * opted into `unreadableIsStale` once it is too old to be mid-publication,
 * while a token that parsed and then made no sense is swept only by the mtime
 * last resort past `hardStaleMs`.
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
  const at = (parsed as { at?: unknown }).at;
  if (typeof at !== "number" || !Number.isFinite(at)) return { kind: "bad-at" };
  if (at < TOKEN_AT_FLOOR_MS || at > now + CLOCK_SKEW_MS) return { kind: "bad-at" };
  return { kind: "token", at, pid: pidOf(parsed) };
}

/**
 * The two windows are the module's whole behaviour, so a caller that passes
 * `NaN`, `0` or an inverted pair is a programming mistake — not a lock state to
 * be conservative about. Throwing is the only answer that surfaces it: silently
 * waiting on a `staleMs` of `NaN` looks exactly like a hung lockfile and gets
 * debugged as one.
 */
function validateSweepOptions(staleMs: number, hardStaleMs: number): void {
  if (!Number.isFinite(staleMs) || staleMs <= 0) {
    throw new Error(
      `stale-lock-sweep: programmer error — staleMs must be a finite number greater than 0, got ${String(staleMs)}`,
    );
  }
  if (!Number.isFinite(hardStaleMs) || hardStaleMs <= 0) {
    throw new Error(
      `stale-lock-sweep: programmer error — hardStaleMs must be a finite number greater than 0, got ${String(hardStaleMs)}`,
    );
  }
  if (hardStaleMs < staleMs) {
    throw new Error(
      `stale-lock-sweep: programmer error — hardStaleMs (${String(hardStaleMs)}) must be >= staleMs (${String(staleMs)}); a ceiling below the stale window makes every lock a corpse the moment it is stale`,
    );
  }
}

/**
 * Judge the lock at `file`, and delete it when — and only when — it is provably
 * a corpse. See the module header for the verdict contract.
 */
export function sweepStaleLockfile(file: string, opts: SweepOptions): HolderRead {
  const hardStaleMs = opts.hardStaleMs ?? opts.staleMs * LOCK_HARD_STALE_MULTIPLIER;
  validateSweepOptions(opts.staleMs, hardStaleMs);
  const now = (opts.now ?? Date.now)();
  const aliveOf = opts.aliveOf ?? processAlive;

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
  // paid for in full. Neither is a token.
  if (!first.isFile()) {
    // Not deletable by anything in this module — `unlinkSync` on a directory
    // fails, and reaching for a recursive remove at a path we did not create is
    // a worse failure than waiting. Both callers' wait windows end in a
    // deadline, so this shape is a stall, never a deadlock.
    return { status: "alive" };
  }
  if (first.size > MAX_LOCK_BYTES) {
    return sweepByMtime(file, first, null, now, opts, hardStaleMs, "larger than any token");
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return { status: "alive" };
    // Readable enough to stat, not to read. An errno is not evidence about a
    // process, so this branch has no delete in it at all — not even for the
    // fail-open lock. The caller's trace gets the errno to name.
    return { status: "unreadable", errno: code };
  }
  const token = classify(raw, now);
  if (token.kind === "no-token") {
    return sweepByMtime(file, first, raw, now, opts, PUBLISH_GRACE_MS, "no parsable token");
  }
  if (token.kind === "bad-at") {
    return sweepByMtime(file, first, raw, now, opts, hardStaleMs, "an `at` outside its domain");
  }

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
        ? "names no usable pid at all"
        : `pid ${String(token.pid)} still answers kill(pid, 0)`;
    traceWarn(
      `stale-lock: swept a ${ageMs}ms-old lockfile past the ${hardStaleMs}ms hard ceiling — its holder ${who}, and at this age a lock is a corpse whether the pid was recycled, zombied, stopped, or simply never written`,
    );
  }
  return { status: "stale", ageMs, pid: token.pid };
}

/**
 * The last resort for a lockfile whose token answers nothing.
 *
 * Nothing in this file can be trusted as a holder, so the only clock left is
 * the filesystem's own record of when the file appeared. Both locks wait unless
 * they opted into `unreadableIsStale`, and the opt-in still refuses to delete
 * anything too young to have finished being published — a lock a sibling
 * created a moment ago is waited out rather than stolen.
 *
 * `overMs` is the two-tier gate: a file we READ and could not PARSE is almost
 * certainly a create whose publish never landed, so a publish grace suffices;
 * every other unjudgeable shape (`bad-at`, oversized) may be a token written by
 * something else entirely, so it waits out the whole hard ceiling first.
 */
function sweepByMtime(
  file: string,
  first: Stats,
  raw: string | null,
  now: number,
  opts: SweepOptions,
  overMs: number,
  why: string,
): HolderRead {
  if (!opts.unreadableIsStale) return { status: "unreadable" };
  const ageMs = now - first.mtimeMs;
  if (ageMs <= overMs) return { status: "alive" };
  if (!deleteIfStillThere(file, first, raw, () => true)) return { status: "unreadable" };
  traceWarn(
    `stale-lock: swept an unjudgeable ${ageMs}ms-old lockfile past ${overMs}ms of its mtime (${why}; no pid to judge)`,
  );
  return { status: "stale", ageMs, pid: null };
}

/**
 * Remove the lockfile the CALLER just created, and only while the path still
 * resolves to the inode its fd holds.
 *
 * A create that succeeds and a publish that throws leaves a file with no token
 * in it: nobody can judge it, and every sibling pays its wait window for a
 * holder that is not one. So the creator must clean it up — but an unlink BY
 * PATH is the theft this module exists to prevent, because between the failed
 * write and the unlink a sibling may have swept our half-written file and
 * created its own lock. The fd is the witness: its inode is the file we made,
 * and the path belongs to us only while it still resolves there.
 */
export function unlinkIfStillOurs(file: string, fd: number): boolean {
  try {
    if (statSync(file).ino !== fstatSync(fd).ino) return false;
    unlinkSync(file);
    return true;
  } catch {
    // Already gone (a sibling's verified sweep won): nothing of ours left to
    // remove, and nothing to report — the create's own error is the fault.
    return false;
  }
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
