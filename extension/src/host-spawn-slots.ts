/**
 * host-spawn-slots — the host-wide ceiling on concurrent Pi children (#1528).
 *
 * `spawn-semaphore.ts` bounds the children of ONE process: its counter is
 * module state. N headless workers on one host therefore admitted N × that cap
 * between them, and nothing said so. This module adds the bound that crosses
 * the process boundary.
 *
 * A slot is a file `slot-<i>` (0 ≤ i < cap) in one private directory per host
 * user. It is claimed atomically, appearing already holding `<hostname> <pid>`
 * (a hard link of a written temp file, so no reader ever sees it empty). A
 * child runs while its process holds a slot; the slot is removed when the
 * child settles, and only while it still names this process. A holder that
 * died without releasing (SIGKILL, power loss) is recovered by PID liveness,
 * never by age — an age sweep would double-admit a live but slow holder — and
 * only when it is provably dead: same hostname (pid namespaces differ across
 * containers, so a foreign pid proves nothing) and the pid gone. Recovery is
 * serialised per slot by a short `mkdir` lock, so two reapers cannot both
 * unlink and steal each other's fresh claim. A process that exits normally
 * drops its slots in an `exit` hook.
 *
 * Waiting is bounded (`PI_ENSEMBLE_HOST_SPAWN_WAIT_MS`, 30 min): past it the
 * spawn fails with an error naming the bound and the holders, so the step
 * parks rather than running unbounded. An abort ends the wait. An unusable
 * slot directory fails open (traced): the per-process cap still applies.
 *
 * Scope: the directory is under `os.tmpdir()` (override
 * `PI_ENSEMBLE_HOST_SPAWN_DIR`); processes share the bound when they share it.
 * `PI_ENSEMBLE_HOST_SPAWN_CAP=0` turns the host-wide bound off; the
 * per-process cap stays underneath it either way.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
/** A reap lock older than this belongs to a reaper that died mid-reap. */
const REAP_LOCK_STALE_MS = 10_000;
const SELF = `${os.hostname()} ${process.pid}`;
const held = new Set<string>();
let exitHooked = false;
let warnedUnusable = false;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holderOf(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Dead only when provably so: this host, a real pid, not ours, and gone. */
function provablyDead(holder: string | undefined): boolean {
  const [host, pidText] = holder?.split(" ") ?? [];
  const pid = Number(pidText);
  if (host !== os.hostname() || !Number.isInteger(pid) || pid <= 0) return false;
  return pid !== process.pid && !pidAlive(pid);
}

/** Atomic claim: link a written temp file to the slot name. */
function link(dir: string, file: string): boolean {
  const tmp = path.join(dir, `.claim-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, SELF);
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

/** Remove a slot whose holder is provably dead, under a per-slot lock. */
function reap(file: string): void {
  const lock = `${file}.reap`;
  try {
    fs.mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > REAP_LOCK_STALE_MS) fs.rmdirSync(lock);
    } catch {
      /* gone already */
    }
    return;
  }
  try {
    const holder = holderOf(file); // re-read under the lock
    if (provablyDead(holder)) {
      fs.unlinkSync(file);
      trace(`host-spawn-slots: recovered ${path.basename(file)} from dead holder ${holder}`);
    }
  } finally {
    fs.rmdirSync(lock);
  }
}

/** Claim one free slot, recovering slots whose holder is provably dead. */
function tryClaim(dir: string, cap: number): string | undefined {
  for (let i = 0; i < cap; i++) {
    const file = path.join(dir, `slot-${i}`);
    if (link(dir, file)) return file;
    if (!provablyDead(holderOf(file))) continue;
    reap(file);
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
  try {
    if (holderOf(file) === SELF) fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** The slot directory, private to this user; undefined when unusable. */
function slotDir(): string | undefined {
  const dir = hostSpawnDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
    if (!st.isDirectory() || st.uid !== uid) throw new Error("not a directory this user owns");
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch (err) {
    if (!warnedUnusable) {
      warnedUnusable = true;
      traceWarn(
        `host-spawn-slots: ${dir} is unusable (${(err as Error).message}) — host-wide bound off, per-process cap still applies`,
      );
    }
    return undefined;
  }
}

/**
 * Run `fn` holding one host-wide slot. Throws a named error when no slot frees
 * within `hostSpawnWaitMs()`, and stops waiting when `signal` aborts.
 */
export async function withHostSpawnSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
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
      file = tryClaim(dir, cap);
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
  try {
    return await fn();
  } finally {
    release(file);
  }
}
