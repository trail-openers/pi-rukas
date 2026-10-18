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
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withHostSpawnSlot } from "../src/host-spawn-slots.ts";
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
const deadHolder = `${os.hostname()} ${dead}`;

async function peakAcrossTwoProcesses(cap: number, name: string, seedDead = 0): Promise<number> {
  const slots = path.join(root, `${name}-slots`);
  const probe = path.join(root, `${name}-probe`);
  fs.mkdirSync(probe, { recursive: true });
  fs.mkdirSync(slots, { recursive: true, mode: 0o700 });
  for (let i = 0; i < seedDead; i++) fs.writeFileSync(path.join(slots, `slot-${i}`), deadHolder);
  const env = {
    ...process.env,
    PI_ENSEMBLE_HOST_SPAWN_DIR: slots,
    PI_ENSEMBLE_HOST_SPAWN_CAP: String(cap),
  };
  const procs = [0, 1].map((_) =>
    spawn(process.execPath, [worker, probe, "3", "400"], { env, stdio: "inherit" }),
  );
  const done = Promise.all(procs.map((p) => new Promise((r) => p.on("exit", r))));
  let peak = 0;
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  while (!finished) {
    peak = Math.max(peak, fs.readdirSync(probe).length);
    await new Promise((r) => setTimeout(r, 10));
  }
  return peak;
}

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
  fs.writeFileSync(path.join(liveDir, "slot-0"), `${os.hostname()} ${holder.pid}`);
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
  fs.rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
