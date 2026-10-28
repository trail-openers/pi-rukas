#!/usr/bin/env bun
/**
 * #1528 — the host-wide spawn bound (host-spawn-slots.ts).
 *
 * The per-process semaphore is module state, so N processes admitted N × its
 * cap. Two real OS processes each run three "children" through
 * withHostSpawnSlot against one slot directory, while this process samples
 * how many are live at once across both:
 *
 *   - with the host cap at 2, the aggregate never exceeds 2;
 *   - with the host bound off (cap 0), the same harness DOES see more than 2
 *     overlap — without this control, "never above 2" would also pass if the
 *     children simply never overlapped.
 *
 * Plus: a slot left by a dead holder is recovered by PID liveness, a wait past
 * the bound fails with a named error, an abort ends the wait, and the resource
 * report labels the two spawn caps per-process and host-wide.
 *
 * #1871 adds the OWNER IDENTITY to the same protocol — `<host> <boot-id>
 * <pid>` — and with it the cases the pid-only body could not express: a slot
 * whose host and boot id match but whose pid belongs to a sibling container is
 * NOT reaped; and an unwritable slot directory is visible as `degraded` in the
 * resource report and warns on every acquisition instead of once per process.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatIdentity, selfIdentity } from "../src/process-liveness.ts";
import { hostSpawnDegraded, withHostSpawnSlot } from "../src/host-spawn-slots.ts";
import { resourceReport } from "../src/resource-budget.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-spawn-slots-"));
const worker = path.join(import.meta.dir, "lib", "host-spawn-worker.ts");

const dead = spawnSync("true").pid ?? 999_999;
/** A dead pid stamped with THIS process's full identity: the reap case. */
const deadHolder = formatIdentity({ ...selfIdentity(), pid: dead });
/** A shape-valid boot id that is not this boot's — a sibling container. */
const FOREIGN_BOOT = "00000000-1111-2222-3333-444444444444";
const LIVE_HOLD_MS = 20_000;

function mkSlots(name: string): string {
  const slots = path.join(root, `${name}-slots`);
  fs.mkdirSync(slots, { recursive: true, mode: 0o700 });
  return slots;
}

/** Read the bodies of this directory's slots (`.reap` locks are not slots). */
function slotBodies(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^slot-\d+$/.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8").trim());
}

async function peakAcrossTwoProcesses(cap: number, name: string, seedDead = 0): Promise<number> {
  const slots = mkSlots(name);
  const probe = path.join(root, `${name}-probe`);
  fs.mkdirSync(probe, { recursive: true });
  // #1871 — seedDead=0 is what this harness always passes. A parent-seeded
  // corpse slot is NOT an idle slot: a worker may observe it between the
  // parent's unlink and its own claim and then wait out the bound, which reads
  // as a hang rather than a failure. The dead-holder reap path is covered by
  // the deterministic `own-dead` case below, so the race here is the pure
  // two-process claim race.
  for (let i = 0; i < seedDead; i++) fs.writeFileSync(path.join(slots, `slot-${i}`), deadHolder);
  const env = {
    ...process.env,
    PI_ENSEMBLE_HOST_SPAWN_DIR: slots,
    PI_ENSEMBLE_HOST_SPAWN_CAP: String(cap),
    // A worker that cannot get a slot must fail LOUD and fast: the sampling
    // loop below only ends when both workers exit, so the 30-minute default
    // wait here would be an unbounded test. `control` (cap 0) never claims.
    PI_ENSEMBLE_HOST_SPAWN_WAIT_MS: "6000",
  };
  const procs = [0, 1].map((_) =>
    spawn(process.execPath, [worker, probe, "3", "400"], { env, stdio: "ignore" }),
  );
  const done = Promise.all(procs.map((p) => new Promise((r) => p.on("exit", r))));
  let peak = 0;
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  const sampleStart = Date.now();
  while (!finished && Date.now() - sampleStart < 30_000) {
    peak = Math.max(peak, fs.readdirSync(probe).length);
    await new Promise((r) => setTimeout(r, 10));
  }
  for (const p of procs) p.kill("SIGKILL");
  return peak;
}

const liveChildren: ChildProcess[] = [];
const deadChildren: ChildProcess[] = [];

try {
  const bounded = await peakAcrossTwoProcesses(2, "bounded");
  assert(
    bounded >= 1 && bounded <= 2,
    `two processes stay within a host cap of 2 (peak ${bounded})`,
  );
  // Both processes race to recover the same dead slots: still never above the cap.
  const raced = await peakAcrossTwoProcesses(2, "raced", 2);
  assert(raced >= 1 && raced <= 2, `racing recoverers stay within the cap (peak ${raced})`);
  const control = await peakAcrossTwoProcesses(0, "control");
  assert(control > 2, `control: with the host bound off they overlap past 2 (peak ${control})`);

  // ── A slot whose holder died is recovered by PID liveness, not age.
  const recDir = path.join(root, "recover");
  fs.mkdirSync(recDir);
  fs.writeFileSync(path.join(recDir, "slot-0"), deadHolder);
  process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = recDir;
  process.env.PI_ENSEMBLE_HOST_SPAWN_CAP = "1";
  process.env.PI_ENSEMBLE_HOST_SPAWN_WAIT_MS = "500";
  let ran = false;
  await withHostSpawnSlot(async () => {
    ran = true;
  });
  assert(ran, "a slot left by a dead pid is recovered at once");
  assert(
    !fs.existsSync(path.join(recDir, "slot-0")),
    "the slot is released when the child settles",
  );

  // ── A live holder past the wait bound: a named error, not an unbounded wait.
  const liveDir = path.join(root, "live");
  fs.mkdirSync(liveDir);
  const holder = spawn("sleep", ["5"]);
  liveChildren.push(holder);
  fs.writeFileSync(
    path.join(liveDir, "slot-0"),
    formatIdentity({ ...selfIdentity(), pid: holder.pid ?? 0 }),
  );
  process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = liveDir;
  let err = "";
  try {
    await withHostSpawnSlot(async () => undefined);
  } catch (e) {
    err = (e as Error).message;
  }
  assert(
    /host-wide spawn bound/.test(err) && err.includes(String(holder.pid)),
    "waiting past the bound fails naming the bound and the holder",
  );
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  process.env.PI_ENSEMBLE_HOST_SPAWN_WAIT_MS = "60000";
  const t0 = Date.now();
  let aborted = "";
  try {
    await withHostSpawnSlot(async () => undefined, ac.signal);
  } catch (e) {
    aborted = (e as Error).message;
  }
  assert(/aborted/.test(aborted) && Date.now() - t0 < 5_000, "an abort ends the wait");
  holder.kill();

  // -- A foreign host's holder is never presumed dead (its pid namespace differs).
  const foreignDir = path.join(root, "foreign");
  fs.mkdirSync(foreignDir);
  fs.writeFileSync(path.join(foreignDir, "slot-0"), `another-host ${dead}`);
  process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = foreignDir;
  process.env.PI_ENSEMBLE_HOST_SPAWN_WAIT_MS = "300";
  let foreign = "";
  try {
    await withHostSpawnSlot(async () => undefined);
  } catch (e) {
    foreign = (e as Error).message;
  }
  assert(/host-wide spawn bound/.test(foreign), "a slot held on another host is not reaped");

  // ── #1871 — SAME host, FOREIGN boot id, a LIVE pid: never reaped.
  //
  // The fixture carries this host's real hostname and a pid that really lives
  // (our own `sleep` child), so the ONLY thing separating it from the reap
  // case is the boot id. Under the pre-#1871 pid-only judgement this slot is
  // called dead and stolen, the spawn runs, and the assertion fails.
  {
    const dir = path.join(root, "foreign-boot");
    fs.mkdirSync(dir);
    const sleep = spawn("sleep", ["30"]);
    deadChildren.push(sleep);
    const body = formatIdentity({
      host: selfIdentity().host,
      bootId: FOREIGN_BOOT,
      pid: sleep.pid ?? 0,
    });
    fs.writeFileSync(path.join(dir, "slot-0"), body);
    process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = dir;
    process.env.PI_ENSEMBLE_HOST_SPAWN_CAP = "1";
    process.env.PI_ENSEMBLE_HOST_SPAWN_WAIT_MS = "400";
    let foreignBoot = "";
    try {
      await withHostSpawnSlot(async () => undefined);
    } catch (e) {
      foreignBoot = (e as Error).message;
    }
    assert(
      /host-wide spawn bound/.test(foreignBoot) &&
        fs.readFileSync(path.join(dir, "slot-0"), "utf8").trim() === body,
      "a slot on OUR host with a FOREIGN boot id and a live pid is not reaped",
    );
    sleep.kill();
  }

  // ── #1871 — an old two-field body is never reaped, even for a live pid.
  {
    const dir = path.join(root, "legacy-body");
    fs.mkdirSync(dir);
    const sleep = spawn("sleep", ["30"]);
    deadChildren.push(sleep);
    fs.writeFileSync(dir + "/slot-0", `${os.hostname()} ${sleep.pid}`);
    process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = dir;
    process.env.PI_ENSEMBLE_HOST_SPAWN_CAP = "1";
    process.env.PI_ENSEMBLE_HOST_SPAWN_WAIT_MS = "400";
    let legacyErr = "";
    try {
      await withHostSpawnSlot(async () => undefined);
    } catch (e) {
      legacyErr = (e as Error).message;
    }
    assert(
      /host-wide spawn bound/.test(legacyErr) && fs.existsSync(dir + "/slot-0"),
      "a pre-#1871 two-field slot body is never reaped",
    );
    sleep.kill();
  }

  // ── #1871 — a dead pid with OUR identity IS reaped (no regression).
  {
    const dir = path.join(root, "own-dead");
    fs.mkdirSync(dir);
    const gone = spawn("sleep", ["0.05"]);
    deadChildren.push(gone);
    await new Promise((r) => gone.on("exit", r));
    fs.writeFileSync(dir + "/slot-0", formatIdentity({ ...selfIdentity(), pid: gone.pid ?? 0 }));
    process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = dir;
    process.env.PI_ENSEMBLE_HOST_SPAWN_CAP = "1";
    process.env.PI_ENSEMBLE_HOST_SPAWN_WAIT_MS = "2000";
    let reapedRan = false;
    await withHostSpawnSlot(async () => {
      reapedRan = true;
    });
    assert(reapedRan, "a slot with our identity and a dead pid is still reaped");
  }

  // ── #1871 — an EACCES slot directory: degraded report + warn every time.
  {
    const dir = path.join(root, "eacces");
    fs.mkdirSync(dir, { mode: 0o700 });
    if (process.getuid?.() === 0) {
      // A 0500 directory does not stop root: mkdir/access succeed whatever the
      // mode bits, so the probe would report a degradation that never
      // happened. Say so rather than print a green line that proves nothing.
      console.log(
        "SKIP EACCES slot-dir probe: running as root, an unwritable directory cannot be provoked",
      );
      fs.chmodSync(dir, 0o700);
    } else {
      fs.chmodSync(dir, 0o500);
      try {
        process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = dir;
        process.env.PI_ENSEMBLE_HOST_SPAWN_CAP = "4";
        process.env.PI_ENSEMBLE_HOST_SPAWN_WAIT_MS = "500";
        const warns: string[] = [];
        const write = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array) => {
          const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
          if (s.includes("host-spawn-slots:")) warns.push(s.trim());
          return true;
        }) as typeof process.stderr.write;
        const ranOnce: boolean[] = [];
        try {
          for (let i = 0; i < 3; i++) {
            await withHostSpawnSlot(async () => {
              ranOnce.push(true);
              return undefined;
            });
          }
        } finally {
          process.stderr.write = write;
        }
        assert(
          warns.length === 3 && warns.every((w) => w.includes("unusable")),
          `an unwritable slot dir warns on every acquisition (got ${warns.length})`,
        );
        assert(ranOnce.length === 3, "and the call still runs with no host cap (fail open)");
        const report = resourceReport().limits.hostSpawnCap;
        assert(
          report.degraded !== undefined && /unusable/.test(report.degraded.reason),
          "resourceReport marks hostSpawnCap degraded with the reason",
        );
        fs.chmodSync(dir, 0o700);
        // Same directory, now writable: the reason must clear rather than
        // latch, so a transient fault cannot disable the host cap forever.
        process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = dir;
        let recoveredRan = false;
        await withHostSpawnSlot(async () => {
          recoveredRan = true;
        });
        assert(
          recoveredRan && hostSpawnDegraded() === undefined,
          "a directory that becomes writable clears the degraded reason (it is not latched)",
        );
      } finally {
        // Restore BOTH the leaf and its parent or the pooled rmSync of the temp
        // root fails for the next test in the file.
        try {
          fs.chmodSync(dir, 0o700);
        } catch {
          /* already restored */
        }
      }
    }
  }

  // -- An unusable slot directory fails open: the spawn still runs.
  const notDir = path.join(root, "a-file");
  fs.writeFileSync(notDir, "");
  process.env.PI_ENSEMBLE_HOST_SPAWN_DIR = notDir;
  let openRan = false;
  await withHostSpawnSlot(async () => {
    openRan = true;
  });
  assert(openRan, "an unusable slot directory does not block the spawn");

  // ── The report says which cap is per process and which is host-wide.
  process.env.PI_ENSEMBLE_HOST_SPAWN_CAP = "0";
  const l = resourceReport().limits;
  assert(l.spawnCap.scope === "process" && l.hostSpawnCap.scope === "host", "scopes are labelled");
  assert(
    l.hostSpawnCap.value === 0 && l.hostSpawnCap.source === "env",
    "an explicit 0 reads as off, from env",
  );
} finally {
  for (const c of [...liveChildren, ...deadChildren]) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const f of fs.readdirSync(root)) {
    try {
      fs.chmodSync(path.join(root, f), 0o700);
    } catch {
      /* not a dir, or already gone */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
