/**
 * host-spawn-slots — the host-wide ceiling on concurrent Pi children (#1528).
 *
 * `spawn-semaphore.ts` bounds the children of ONE process: its counter is
 * module state. N headless workers on one host therefore admitted N × that cap
 * between them, and nothing said so. This module adds the bound that crosses
 * the process boundary.
 *
 * A slot is a file `slot-<i>` (0 ≤ i < cap) in one private directory per host
 * user. It is claimed atomically, appearing already holding
 * `<host> <pidns> <pid> <starttime>` (a hard link of a written temp file, so no
 * reader ever sees it empty) — the identity `process-liveness.ts` produces
 * (#1871). A child runs while its process holds a slot; the slot is removed
 * when the child settles, and only while it still names this process. While
 * this process holds ANY slot it also refreshes every held slot's mtime on a
 * 60-second UNREF'd beat, so a holder that dies without releasing (SIGKILL,
 * power loss) goes quiet and is recoverable — never by the age of a holder that
 * is merely slow, which heartbeats and so never looks silent.
 *
 * Recovery has two rules, and which one applies depends on whether this process
 * may judge the holder at all:
 *
 *   - JUDGEABLE (this host, this pid namespace): only when `judgeOwner` proves
 *     it dead — the pid is gone, or it is alive but its `/proc` start time no
 *     longer matches the recorded one (the pid was recycled). Never by age.
 *   - FOREIGN (another host or namespace, or a body that does not parse): the
 *     probe cannot run, so silence is the only evidence. A holder silent past
 *     the 10-minute LEASE is reclaimed; a live one heartbeats.
 *   - LEGACY `<host> <pid>` (pre-#1871): the released pid-only verdict and
 *     NOTHING else — no lease, because those writers never heartbeated and
 *     their silence means nothing (D3).
 *
 * Recovery is serialised per slot by a short `mkdir` lock, so two reapers cannot
 * both unlink and steal each other's fresh claim. A lock left by a reaper that
 * died mid-reap is CLEARED by the next attempt on that slot, and that attempt
 * then proceeds — a lock does not age out on its own, because nothing polls the
 * directory when nobody is claiming. A process that exits normally drops its
 * slots in an `exit` hook.
 *
 * The accepted cost of that safe direction: a live holder that is SIGSTOPped
 * for longer than the lease can have its slot taken by a sibling container
 * (nothing it does while stopped refreshes the lease); a same-namespace holder
 * never is, because that one is settled by pid. See docs/headless.md.
 *
 * Waiting is bounded (`PI_ENSEMBLE_HOST_SPAWN_WAIT_MS`, 30 min): past it the
 * spawn fails with an error naming the bound and the holders, so the step
 * parks rather than running unbounded. An abort ends the wait. An unusable
 * slot directory fails open (traced): the per-process cap still applies, and
 * since #1871 the reason is readable through `hostSpawnDegraded()` so the
 * cycle's resource report says the host cap is not in force rather than going
 * quiet.
 *
 * Scope: the directory is under `os.tmpdir()` (override
 * `PI_ENSEMBLE_HOST_SPAWN_DIR`); processes share the bound when they share it.
 * `PI_ENSEMBLE_HOST_SPAWN_CAP=0` turns the host-wide bound off; the
 * per-process cap stays underneath it either way.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NO_ID_FIELD,
  formatIdentity,
  judgeOwner,
  parseIdentity,
  selfIdentity,
} from "./process-liveness.ts";
import { trace, traceWarn } from "./trace.ts";

/** Host-wide concurrent children. Default 64, the per-process default. */
export function hostSpawnCap(): number {
  const n = Number(process.env.PI_ENSEMBLE_HOST_SPAWN_CAP);
  return Number.isInteger(n) && n >= 0 && process.env.PI_ENSEMBLE_HOST_SPAWN_CAP !== "" ? n : 64;
}

/** How long a spawn may wait for a host-wide slot (default 30 min). */
export function hostSpawnWaitMs(): number {
  const n = Number(process.env.PI_ENSEMBLE_HOST_SPAWN_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

/** The shared slot directory. */
export function hostSpawnDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return (
    process.env.PI_ENSEMBLE_HOST_SPAWN_DIR || path.join(os.tmpdir(), `pi-rukas-spawn-slots-${uid}`)
  );
}

const POLL_MS = 250;
/**
 * A reap lock older than this belongs to a reaper that died mid-reap. The next
 * reap attempt on THAT slot clears it and PROCEEDS — a lock never ages out on
 * its own, because nothing is polling the directory when no one is claiming.
 */
const REAP_LOCK_STALE_MS = 10_000;
/**
 * How long a FOREIGN (or unparseable) slot may stay silent before a sibling may
 * take it. Only meaningful against the heartbeat: a live holder touches its
 * slots every `HEARTBEAT_MS`, so ten beats of slack separate "slow" from
 * "stopped". A holder this process can judge by pid is reaped on liveness
 * alone, never on this clock.
 */
const FOREIGN_SLOT_LEASE_MS = 10 * 60_000;
/** How often a holder refreshes the mtimes of the slots it holds. */
const HEARTBEAT_MS = 60_000;
const held = new Set<string>();
let exitHooked = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Why the host-wide bound is NOT in force for this process, or undefined. */
let degradedReason: string | undefined;
/**
 * The last `degradedReason` a WARN line was printed for. `slotDir()` runs on
 * every acquisition — once per spawn, and once per 250 ms poll of a wait loop —
 * so printing on every call is a flood, and printing once per process was the
 * silence #1871 removed. The line is therefore printed on a CHANGE of value:
 * once when the directory becomes unusable, once when it becomes writable
 * again. `degradedReason` itself is still assigned on every call, so the
 * resource report never goes stale.
 */
let warnedDegradedReason: string | undefined;

/**
 * Why the host-wide bound was skipped, or undefined when it is in force.
 *
 * #1871 — the module used to warn ONCE about an unusable directory and then
 * run every spawn without a host cap in silence, so a root-owned slot dir
 * (EACCES for a non-root uid) quietly disabled the cap for the whole host and
 * nothing downstream could see it. The reason is kept so `resourceReport()`
 * can mark the limit degraded, and the warning is printed on every
 * acquisition attempt rather than once per process.
 */
export function hostSpawnDegraded(): { reason: string } | undefined {
  return degradedReason === undefined ? undefined : { reason: degradedReason };
}

function holderOf(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * How long this slot's holder has been silent, in ms.
 *
 * The clock is `min(mtime, ctime)` of the body, never the two clocks of two
 * machines: the beat writes with `utimesSync(now, now)`, which moves mtime
 * forward, so mtime alone is "last heartbeat"; ctime moves when the body is
 * created or re-written, so a body swapped under a live slot restarts its lease
 * rather than being reclaimed on the age of the original link. Taking the
 * earlier of the two is the conservative choice for BOTH: a holder that has not
 * beaten recently looks silent, and a body that was just touched is not taken.
 *
 * An unreadable file reads as `Number.NEGATIVE_INFINITY` silent, which is
 * NEVER lease-reapable: `silentPastLease` compares against the lease, so a
 * file this process cannot stat is one whose silence it has not established,
 * and a lease may not take a slot on evidence it does not have. Proving a
 * holder dead from a failed `stat` is the same class of bug as proving one
 * alive from a missing field — a torn write or a momentary EACCES on the body
 * would double-admit a live child, which is the failure this cap exists to
 * prevent. The heartbeat tolerates the same failure in the other direction: a
 * slot we hold but cannot touch stays held, it simply does not look fresh.
 */
function silentForMs(file: string): number {
  try {
    const st = fs.statSync(file);
    return Date.now() - Math.min(st.mtimeMs, st.ctimeMs);
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/**
 * Dead only when provably so. #1871: the judgement is `judgeOwner`'s, which
 * consults the pid probe only for a holder carrying THIS host and THIS pid
 * namespace whose start time still matches `/proc`; a foreign body — other
 * host, other namespace, or half an identity — is never dead, so it is never
 * reaped on liveness.
 */
function provablyDead(holder: string | undefined): boolean {
  return judgeOwner(parseIdentity(holder), selfIdentity()) === "dead";
}

/**
 * May a slot nobody may judge by pid be taken on the lease alone?
 *
 * #1871 F5 — the rule is one verdict: `judgeOwner`'s. A slot is lease-reapable
 * exactly when its body does not parse at all, or when the same judge the
 * liveness path uses calls the holder `foreign`. A holder that is judgeable
 * (this host, this pid namespace) is settled by the pid probe and is NEVER
 * taken on silence — an age rule on a judgeable holder could only ever steal a
 * live-but-slow holder's slot, and letting the lease and the probe disagree on
 * one body is how a live child's slot disappears.
 *
 * A legacy two-field body never lease-reaps. `parseIdentity` gives it
 * `pidns: "-"` and `startTime: ""` — the ABSENCE of both fields, which a writer
 * with an unreadable `/proc` does not have — and its writer predates the
 * heartbeat, so its silence means nothing: D3 gives it the pid probe and nothing
 * else. The `"-"`/`""` pair is checked by name rather than inferred from the
 * verdict, because a legacy body on ANOTHER host parses to `foreign` and would
 * otherwise be reaped on a clock its writer never kept.
 */
function leaseReapable(body: string | undefined, silentPastLease: boolean): boolean {
  if (!silentPastLease) return false;
  const id = parseIdentity(body);
  if (id === undefined) return true;
  // The legacy `<host> <pid>` shape first: `parseIdentity` gives it `pidns: "-"`
  // and `startTime: ""`, and it is recognised by BOTH fields being absent, not
  // by the sentinel (a Linux writer whose `/proc` is unreadable has a real
  // namespace field and a `"-"` start time, and IS judgeable).
  if (id.pidns === NO_ID_FIELD && id.startTime === "") return false;
  return judgeOwner(id, selfIdentity()) === "foreign";
}

/**
 * Is this slot both silent past the lease and eligible for the lease at all?
 * `leaseMs` is a parameter, not an env read: it exists so the offline suite can
 * pin the lease without sleeping ten minutes.
 */
function reclaimableOnLease(file: string, holder: string | undefined, leaseMs: number): boolean {
  return leaseReapable(holder, silentForMs(file) >= leaseMs);
}

/** Atomic claim: link a written temp file to the slot name. */
function link(dir: string, file: string): boolean {
  // #1871 F7 — a random suffix, not `Math.random()`: two processes that reach
  // the same slot in the same tick on the same pid must not collide on their
  // scratch name (and a slot directory is world-tmp, so a predictable name is
  // also a name another uid can pre-create).
  const tmp = path.join(dir, `.claim-${process.pid}-${randomBytes(8).toString("hex")}`);
  fs.writeFileSync(tmp, formatIdentity(selfIdentity()));
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Remove a slot whose holder is provably dead, or foreign and silent past the
 * lease, under a per-slot lock.
 */
function reap(file: string, leaseMs: number = FOREIGN_SLOT_LEASE_MS): void {
  const lock = `${file}.reap`;
  try {
    fs.mkdirSync(lock);
  } catch {
    // The lock exists: whoever holds it is mid-reap, UNLESS it is older than a
    // reaper can plausibly take. Then its owner died, and THIS attempt clears
    // it and proceeds rather than giving up on the slot for another caller.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > REAP_LOCK_STALE_MS) {
        fs.rmdirSync(lock);
        fs.mkdirSync(lock);
      } else {
        return;
      }
    } catch {
      return;
    }
  }
  try {
    // Re-read body AND age under the lock: a heartbeat that lands while we were
    // waiting for the lock must be seen, not judged from a stale sample. A lock
    // left by a reaper that died does not block the slot forever: it is cleared
    // by the next reap attempt once older than `REAP_LOCK_STALE_MS` (10 s) and
    // that attempt proceeds — the same threshold, stated identically here, in
    // `REAP_LOCK_STALE_MS` above, and in docs/headless.md and
    // docs/troubleshooting.md.
    const holder = holderOf(file);
    if (provablyDead(holder)) {
      fs.unlinkSync(file);
      trace(`host-spawn-slots: recovered ${path.basename(file)} from dead holder ${holder}`);
    } else if (reclaimableOnLease(file, holder, leaseMs)) {
      fs.unlinkSync(file);
      trace(
        `host-spawn-slots: recovered ${path.basename(file)} from a silent foreign holder ${holder ?? "<unreadable>"} (past the lease)`,
      );
    }
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* another attempt already cleared it */
    }
  }
}

/** Claim one free slot, recovering dead and lease-expired holders. */
function tryClaim(dir: string, cap: number, leaseMs: number = FOREIGN_SLOT_LEASE_MS) {
  for (let i = 0; i < cap; i++) {
    const file = path.join(dir, `slot-${i}`);
    if (link(dir, file)) return file;
    const holder = holderOf(file);
    if (!provablyDead(holder) && !reclaimableOnLease(file, holder, leaseMs)) continue;
    reap(file, leaseMs);
    if (link(dir, file)) return file;
  }
  return undefined;
}

function holders(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^slot-\d+$/.test(f))
      .map((f) => holderOf(path.join(dir, f)))
      .filter((h): h is string => h !== undefined);
  } catch {
    return [];
  }
}

/** Unlink a slot only while it still names this process. */
function release(file: string): void {
  held.delete(file);
  stopHeartbeatIfIdle();
  try {
    if (holderOf(file) === formatIdentity(selfIdentity())) fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Stop holding a slot this process can no longer prove it owns (#1871 F6).
 * Separate from `release` because this one never unlinks: the slot belongs to
 * someone else now, and unlinking it would steal *their* admission.
 */
function dropHeld(file: string, why: string): void {
  trace(`host-spawn-slots: dropped ${path.basename(file)} from the held set — ${why}`);
  held.delete(file);
  stopHeartbeatIfIdle();
}

/**
 * Touch every slot this process holds, so a sibling cannot mistake a slow but
 * live holder for an orphan on the lease. Errors are traced and ignored: the
 * heartbeat is a courtesy to the reaper, never a reason to fail a spawn.
 *
 * #1871 F6 — a slot whose body no longer names this process is not ours to keep
 * fresh: a sibling took it (or an operator cleared it and someone re-claimed the
 * name), so beating on it would hold a stranger's admission open forever. It
 * leaves `held` with a trace, and `dropHeld` never unlinks — the slot is not
 * ours to remove.
 */
function heartbeatHeldSlots(): void {
  const now = new Date();
  const mine = formatIdentity(selfIdentity());
  for (const file of [...held]) {
    if (holderOf(file) !== mine) {
      dropHeld(file, "its body no longer names this process");
      continue;
    }
    try {
      fs.utimesSync(file, now, now);
    } catch (err) {
      trace(`host-spawn-slots: heartbeat ${path.basename(file)} failed: ${(err as Error).message}`);
    }
  }
}

function startHeartbeat(): void {
  if (heartbeat !== undefined) return;
  // UNREF'd: a held slot must never be the reason a process stays alive.
  heartbeat = setInterval(heartbeatHeldSlots, HEARTBEAT_MS);
  heartbeat.unref?.();
}

function stopHeartbeatIfIdle(): void {
  if (held.size === 0 && heartbeat !== undefined) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
}

/**
 * The slot directory, private to this user; undefined when unusable.
 *
 * The directory that EXISTS but cannot be written (EACCES, or owned by another
 * uid) is the failure the reporter hit: a root-owned 0755 dir with a non-root
 * uid. Both the trace line and `degradedReason` are set on EVERY call, so the
 * warning recurs once per acquisition — never once per 250 ms poll, which is
 * why it lives here and not in `withHostSpawnSlot`'s loop — and the reason is
 * live for whoever reports the budget.
 */
function slotDir(): string | undefined {
  const dir = hostSpawnDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
    if (!st.isDirectory() || st.uid !== uid) throw new Error("not a directory this user owns");
    fs.accessSync(dir, fs.constants.W_OK);
    // #1871 F7 — `mode: 0o700` is only applied when `mkdir` CREATES the
    // directory: an existing one keeps whatever mode its creator gave it, which
    // is how a `0777` slot directory survives in a shared `/tmp` and lets one
    // uid unlink another's slots. When this uid owns it, enforce the private
    // mode. A directory we do not own is refused above, never chmod'd.
    if (typeof process.getuid === "function" && st.uid === process.getuid())
      fs.chmodSync(dir, 0o700);
    degradedReason = undefined;
    if (warnedDegradedReason !== undefined) {
      traceWarn(
        "host-spawn-slots: the slot directory is usable again — host-wide bound back in force",
      );
      warnedDegradedReason = undefined;
    }
    return dir;
  } catch (err) {
    const reason = `${dir} is unusable (${(err as Error).message}) — host-wide bound off, per-process cap still applies`;
    degradedReason = reason;
    // #1871 F3 — one line per TRANSITION, not one per call: `slotDir()` runs on
    // every acquisition and every 250 ms poll of the wait loop, so the old
    // "warn every time" printed thousands of identical lines on one wedged host.
    if (warnedDegradedReason !== reason) {
      traceWarn(`host-spawn-slots: ${reason}`);
      warnedDegradedReason = reason;
    }
    return undefined;
  }
}

/**
 * Run `fn` holding one host-wide slot. Throws a named error when no slot frees
 * within `hostSpawnWaitMs()`, and stops waiting when `signal` aborts.
 *
 * `leaseMs` is a parameter and not an env read: it exists so the offline suite
 * can pin the foreign-holder lease without sleeping ten minutes. Production
 * callers never pass it.
 */
export async function withHostSpawnSlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  leaseMs: number = FOREIGN_SLOT_LEASE_MS,
): Promise<T> {
  const cap = hostSpawnCap();
  const dir = cap === 0 ? undefined : slotDir();
  if (!dir) return fn();
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => {
      for (const f of [...held]) release(f);
    });
  }
  const waitMs = hostSpawnWaitMs();
  const start = Date.now();
  let file: string | undefined;
  for (;;) {
    if (signal?.aborted) throw new Error("host-wide spawn slot wait aborted");
    try {
      file = tryClaim(dir, cap, leaseMs);
    } catch (err) {
      traceWarn(`host-spawn-slots: claim failed (${(err as Error).message}) — running unbounded`);
      return fn();
    }
    if (file) break;
    if (Date.now() - start >= waitMs) {
      throw new Error(
        `host-wide spawn bound: no slot freed within ${waitMs}ms ` +
          `(PI_ENSEMBLE_HOST_SPAWN_CAP=${cap}; held by ${[...new Set(holders(dir))].join(", ") || "unknown"})`,
      );
    }
    // Jittered, so processes waiting on one slot do not poll in lockstep.
    await new Promise((r) => setTimeout(r, POLL_MS / 2 + Math.random() * POLL_MS));
  }
  const waited = Date.now() - start;
  if (waited >= POLL_MS) trace(`host-spawn-slots: waited ${waited}ms for a host-wide slot`);
  held.add(file);
  startHeartbeat();
  // Touch on claim as well as on the beat: the first `HEARTBEAT_MS` of a hold
  // would otherwise show an mtime as old as the claim itself, which is exactly
  // the window a sibling is most likely to be scanning the directory in.
  heartbeatHeldSlots();
  try {
    return await fn();
  } finally {
    release(file);
  }
}
