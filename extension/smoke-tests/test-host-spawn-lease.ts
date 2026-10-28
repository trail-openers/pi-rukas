#!/usr/bin/env bun
/**
 * #1871 — the slot HEARTBEAT, the foreign-slot LEASE and the stale reap lock.
 *
 * A slot is claimed by a hard link and released by `unlink`. Between those two
 * events the file's mtime never changes, so `host-spawn-slots.ts` cannot tell
 * "a sibling container's holder is alive but slow" from "a sibling container
 * was SIGKILLed" — and it must not guess, because guessing wrong either
 * double-admits a live child or wedges the host cap on a corpse forever.
 *
 * The rules this file pins:
 *
 *   1. While this process holds a slot it TOUCHES that slot's mtime on a beat,
 *      and the beat is UNREF'd and stops the moment nothing is held. A REF'd
 *      timer would keep a finished process alive; a beat that outlives the
 *      holdings keeps a dead container's slots looking fresh forever.
 *   2. A FOREIGN (or unparseable) slot may be reaped once its mtime is older
 *      than the lease. A live foreign holder heartbeats, so silence past the
 *      lease is the only evidence available for a namespace this process cannot
 *      probe.
 *   3. A `.reap` lock left by a reaper that died is CLEARED by the next attempt
 *      on that slot and the attempt PROCEEDS. The old shape cleared the lock and
 *      then returned, so one crash cost the slot until someone claimed again.
 *
 * A legacy two-field `<host> <pid>` body gets NEITHER lease: its writer
 * predates the heartbeat, so its silence is not evidence (D3).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NO_ID_FIELD,
  formatIdentity,
  selfIdentity,
  startTimeOfPid,
} from "../src/process-liveness.ts";
import { withHostSpawnSlot } from "../src/host-spawn-slots.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-spawn-lease-"));
/** Well past any lease in the module (10 min), so an aged slot is unambiguously silent. */
const ANCIENT_S = 40_000;
/** The lease these cases hand in — far below ANCIENT_S, far above a fresh file. */
const LEASE_MS = 60_000;

function dir(name: string): string {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = d;
  process.env.PI_ENSEMBLE_HOST_SPAWN_CAP = "1";
  process.env.PI_ENSEMBLE_HOST_SPAWN_WAIT_MS = "250";
  return d;
}

function slot(d: string): string {
  return path.join(d, "slot-0");
}

/** Age a file's mtime into the past — the shape a silent, dead holder leaves. */
function age(file: string, seconds: number): void {
  const t = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(file, t, t);
}

/** Field 22 of `/proc/<pid>/stat` for a child this test spawned, or "-".
 * Same offset the judge reads, so the stamped value is one a real probe agrees
 * with — a value that disagreed would make the holder a RECYCLED pid and turn
 * this case into a test of the start-time rule instead of the lease. */
function readStart(pid: string): string {
  return startTimeOfPid(Number(pid));
}

/** Run one acquisition, returning the error message or "" when it ran. */
async function acquire(d: string, leaseMs: number): Promise<{ ran: boolean; err: string }> {
  let ran = false;
  let err = "";
  try {
    await withHostSpawnSlot(
      async () => {
        ran = true;
      },
      undefined,
      leaseMs,
    );
  } catch (e) {
    err = (e as Error).message;
  }
  return { ran, err };
}

/**
 * A slot file whose holder is NOT this process, aged well past the lease. Its
 * body names `stalePid`, a pid this test kills — never `process.pid`, which
 * would make the file this process's own identity and route it to the pid probe
 * instead of the lease.
 */
function agedForeignSlot(d: string, stalePid: number): string {
  const f = slot(d);
  fs.writeFileSync(f, formatIdentity({ ...ME, host: SIBLING, pid: stalePid }));
  age(f, ANCIENT_S);
  return f;
}

/**
 * Seed this process's OWN identity into a slot, age it far past any lease, and
 * try to acquire: the slot must still be there afterwards. If the lease could
 * reach a same-host holder, this is where it would — and the wait bound, not a
 * reap, is what ends the attempt.
 */
async function acquireOwnIdentitySurvives(d: string): Promise<{ ran: boolean }> {
  const f = slot(d);
  try {
    fs.unlinkSync(f);
  } catch {
    /* first claim of the directory */
  }
  fs.writeFileSync(f, formatIdentity(ME));
  age(f, ANCIENT_S);
  let ran = false;
  try {
    await withHostSpawnSlot(
      async () => {
        ran = true;
      },
      undefined,
      1,
    );
  } catch {
    /* the wait bound: the expected outcome for a holder that cannot be reaped */
  }
  return { ran: ran && !fs.existsSync(f) };
}

/** A child that exits at once, leaving a pid that is certainly not alive. */
function reapedPid(): number {
  return spawnSync("true").pid ?? 999_999;
}

const ME = selfIdentity();
const SIBLING = `${ME.host}-sibling`;
const children: (() => void)[] = [];

try {
  // ── 1. the heartbeat: the module refreshes each held slot's mtime ----------
  {
    const src = fs.readFileSync(
      path.join(import.meta.dir, "..", "src", "host-spawn-slots.ts"),
      "utf8",
    );
    assert(/utimesSync\(/.test(src), "the heartbeat touches held slots with fs.utimesSync");
    assert(
      /for \(const file of \[\.\.\.held\]\)/.test(src),
      "it touches EVERY held slot, not just the one just claimed",
    );
    assert(
      /heartbeatHeldSlots[\s\S]{0,400}catch/.test(src),
      "a failing touch is caught, so a heartbeat error cannot fail a spawn",
    );
    assert(
      /\.unref\?\.\(\)/.test(src) || /\.unref\(\)/.test(src),
      "the heartbeat interval is unref'd — a held slot cannot keep the process alive",
    );
    const startLine = src.split("\n").findIndex((l) => l.includes("setInterval(heartbeatHeldSlots"));
    assert(startLine >= 0, "the beat is one setInterval over the held set");
    const window = src
      .split("\n")
      .slice(startLine, startLine + 4)
      .join("\n");
    assert(/unref/.test(window), "the setInterval handle specifically is the one unref'd");
    assert(/clearInterval\(heartbeat\)/.test(src), "the beat is cleared, not left running");
    assert(/held\.size === 0/.test(src), "the beat stops exactly when `held` empties");
  }

  // ── 2. a held slot's mtime is refreshed while the callback runs -----------
  {
    const d = dir("heartbeat");
    const f = slot(d);
    // Age a file this process does NOT hold, then claim it: the claim path must
    // refresh the mtimes of what it holds, and the fresh link's own mtime is the
    // observable result. A slot we merely aged from outside stays aged — the
    // beat maintains OUR slots, not somebody else's.
    fs.writeFileSync(f, formatIdentity({ ...ME, host: SIBLING, pid: reapedPid() }));
    age(f, ANCIENT_S);
    const aged = (Date.now() - fs.statSync(f).mtimeMs) / 1000;
    let heldAge = 0;
    await withHostSpawnSlot(
      async () => {
        heldAge = (Date.now() - fs.statSync(slot(d)).mtimeMs) / 1000;
      },
      undefined,
      LEASE_MS,
    );
    assert(aged > 30_000, "the pre-existing foreign slot was aged into the past (fixture took)");
    assert(
      heldAge < 30_000,
      `the slot this process holds is touched at claim time, so a live holder is never silent (age ${Math.round(heldAge)}s)`,
    );
    // And the beat runs on the held set: a slot this process holds cannot be
    // taken by a sibling on a 1 ms lease, because our own beat keeps it fresh.
    let reclaimed = false;
    await withHostSpawnSlot(
      async () => {
        reclaimed = true;
      },
      undefined,
      1,
    );
    assert(reclaimed, "our own held slot survives a lease of 1 ms (the beat, not the clock)");
  }

  // ── 3. a foreign slot YOUNGER than the lease is kept ----------------------
  {
    const d = dir("foreign-young");
    const body = formatIdentity({ ...ME, host: SIBLING, pid: 999_999 });
    fs.writeFileSync(slot(d), body);
    const { ran, err } = await acquire(d, LEASE_MS);
    assert(
      !ran && /host-wide spawn bound/.test(err) && fs.existsSync(slot(d)),
      "a foreign slot inside its lease is left alone (a live foreign holder heartbeats)",
    );
  }

  // ── 4. a foreign slot OLDER than the lease is reaped ----------------------
  {
    const d = dir("foreign-old");
    agedForeignSlot(d, reapedPid());
    const { ran, err } = await acquire(d, LEASE_MS);
    assert(
      ran && err === "",
      "a foreign slot silent past the lease is reaped and the spawn proceeds",
    );
  }

  // ── 5. an UNPARSEABLE slot body follows the lease too ---------------------
  {
    const d = dir("garbage-old");
    fs.writeFileSync(slot(d), "written-by-something-else-entirely");
    age(slot(d), ANCIENT_S);
    const { ran } = await acquire(d, LEASE_MS);
    assert(ran, "a slot whose body does not parse is reaped on the lease, not kept forever");
  }

  // ── 6. a legacy two-field body is NEVER reaped on the lease ---------------
  {
    const d = dir("legacy-old");
    // A foreign host, so the pid probe is not even consulted: the ONLY rule
    // that could take this slot is the lease, and D3 forbids it — the writer
    // predates the heartbeat, so silence proves nothing about it.
    fs.writeFileSync(slot(d), `${SIBLING} 999999`);
    age(slot(d), ANCIENT_S);
    const { ran, err } = await acquire(d, LEASE_MS);
    assert(
      !ran && /host-wide spawn bound/.test(err) && fs.existsSync(slot(d)),
      "a pre-#1871 two-field body is never reaped on the lease — its writer never heartbeats",
    );
  }

  // ── 7. a same-namespace holder alive is never reaped on the lease ---------
  {
    const d = dir("same-host-old");
    const sleep = Bun.spawn(["sleep", "30"]);
    children.push(() => {
      try {
        sleep.kill();
      } catch {
        /* gone */
      }
    });
    // The holder's REAL start time, read the way the judge reads it: a stamped
    // value that does not match `/proc` makes this a recycled pid, which the
    // pid probe reaps, and the case would then prove the probe rather than the
    // lease.
    const body = formatIdentity({ ...ME, pid: sleep.pid, startTime: readStart(String(sleep.pid)) });
    fs.writeFileSync(slot(d), body);
    age(slot(d), ANCIENT_S);
    const { ran, err } = await acquire(d, LEASE_MS);
    assert(
      !ran && /host-wide spawn bound/.test(err) && fs.existsSync(slot(d)),
      "a live same-namespace holder is never reaped on the lease, however silent its mtime",
    );
  }

  // ── 8. a stale `.reap` lock is cleared AND the reap proceeds --------------
  {
    const d = dir("stale-lock");
    const f = agedForeignSlot(d, reapedPid());
    const lock = `${f}.reap`;
    fs.mkdirSync(lock);
    age(lock, 120); // older than REAP_LOCK_STALE_MS (10 s)
    const { ran } = await acquire(d, LEASE_MS);
    assert(
      ran && !fs.existsSync(f),
      "a reap attempt clears a stale lock and reaps the slot rather than giving up on it",
    );
    assert(!fs.existsSync(lock), "the reap removes its own lock when it finishes");
  }

  // ── 9. a FRESH `.reap` lock is respected ----------------------------------
  {
    const d = dir("fresh-lock");
    const f = agedForeignSlot(d, reapedPid());
    const lock = `${f}.reap`;
    fs.mkdirSync(lock); // mtime = now: another reaper is mid-reap
    const { ran, err } = await acquire(d, LEASE_MS);
    assert(
      !ran && /host-wide spawn bound/.test(err) && fs.existsSync(f),
      "a live reap lock is respected: the slot is not stolen out from under its reaper",
    );
    fs.rmdirSync(lock);
  }

  // ── 10. a same-host slot is settled by the probe, never by the lease ------
  {
    const d = dir("own-slot");
    // Our OWN identity, aged past any lease. The lease must not take it (we are
    // alive, and the probe says so); the probe must also not take it, because a
    // body stamped with our own start time names a process that is running.
    // Acquisition therefore succeeds only because the slot is OURS to hold and
    // the release path drops it — the point is that no lease reap is involved.
    const f = slot(d);
    fs.writeFileSync(f, formatIdentity({ ...ME, pid: reapedPid() }));
    age(f, ANCIENT_S);
    const { ran } = await acquire(d, 1);
    assert(ran, "a same-host slot is judged by the probe, not taken on the lease");
    const { ran: oursSurvives } = await acquireOwnIdentitySurvives(d);
    assert(
      !oursSurvives,
      "our own identity's slot is never reaped on the lease — the wait bound, not a reap, is what ends it",
    );
  }
} finally {
  for (const kill of children) {
    try {
      kill();
    } catch {
      /* gone */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
