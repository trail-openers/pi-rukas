#!/usr/bin/env bun
/**
 * #1023 (EPIC #1018 S1) — child-lifecycle SPIKE, NOT an offline smoke test.
 *
 * Deliberately named `spike-*.ts` (not `test-*.ts`) so the offline gate
 * (`bun run smoke-tests/test-*.ts` via verify-loop.sh) never globs it. It
 * spawns real processes and reads real `ps` output, so it is a manual,
 * local + sandboxed probe — run by hand on macOS and on Linux, not in CI.
 *
 * Question it answers (EPIC #1018, Headless S1): when a NON-Pi bun parent
 * spawns a child EXACTLY the way `spawn.ts` does —
 *
 *     spawn(cmd, args, { shell: false, stdio: ["pipe","pipe","pipe"] })
 *
 * (no `detached` flag → the child shares the parent's process group) and the
 * parent then dies in one of three ways, what happens to the child?
 *
 *   (a) normal exit   (process.exit / clean return)
 *   (b) SIGTERM       (the common "kill <pid>" case)
 *   (c) SIGKILL       (the force-kill case)
 *
 * The child is a FAKE `pi` binary: a shell script that prints its own PID and
 * then sits in a long `sleep` loop, so it is provably long-lived (well past
 * the moment of parent death) and makes NO model calls — nothing here costs
 * tokens. That is the whole point: the behaviour under test is the OS /
 * child-process-group relationship, not any Pi runtime, and `killAllJobs`
 * (async-jobs-lifecycle.ts) is never invoked because a non-Pi parent never
 * registers `pi.on("session_shutdown")` (index.ts).
 *
 * Survival is measured by a `ps` check (pid → PPID / PGID / STAT) run from
 * this process (the probe) AFTER the parent has died, so the probe itself
 * cannot be the surviving entity. A child that survives shows `PPID` re-
 * assigned (1 / init on Linux, launchd's pid on macOS) while its `PGID`
 * still reflects the shared group.
 *
 * Run (macOS local):
 *     cd extension && bun run smoke-tests/spike-child-lifecycle.ts
 * Run (Linux, sandbox image):
 *     bun run smoke-tests/spike-child-lifecycle.ts   # same path
 *
 * Each scenario takes a few seconds; the whole run is ~30s. Output is
 * pasted into EPIC #1018's body by ops — do not interpret `ps` exit codes
 * from the run itself; read the emitted table.
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `ps`-based survival probe. Returns null when the pid is gone (ps exits
 * non-zero) or a row of its current process attributes when it is alive.
 *
 * We deliberately do NOT rely on `waitpid` (this process is not the child's
 * parent — the child's parent is the *dead* parent, so `waitpid` would just
 * say ECHILD). `ps -p` is the OS-level ground truth: if the kernel still
 * lists the pid, the child survived the parent's death.
 */
function probe(pid: number): { ppid: number; pgid: number; stat: string } | null {
  try {
    const out = execSync(`ps -p ${pid} -o ppid=,pgid=,stat=`, {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim();
    if (!out) return null;
    const [ppid, pgid, stat] = out.split(/\s+/);
    return { ppid: Number(ppid), pgid: Number(pgid), stat: stat ?? "?" };
  } catch {
    // ps exits 1 when the pid does not exist → child is dead.
    return null;
  }
}

/**
 * Wait until the child emits its `FAKEPI_PID <n>` line (proof it started) or
 * the timeout fires. The fake child sleeps for SECONDS, so "started" is
 * stable — we are not racing a short-lived process.
 */
function waitChildReady(child: { pid: number | undefined }, out: { value: string }, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (/FAKEPI_PID \d+/.test(out.value)) return resolve();
      if (Date.now() > deadline) return resolve(); // give up; child still reported below
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Spawn the fake-`pi` child with EXACTLY the spawn.ts option shape and return
 * its pid. We mirror spawn.ts:184-192 byte-for-byte on the options that matter
 * to the OS: shell:false, stdio pipes, and NO detached flag (so the child
 * inherits the parent's process group — the crux of the S1 question).
 */
function spawnFakePi(fakePi: string, out: { value: string }): { pid: number } {
  const child = spawn(fakePi, [], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    // env is intentionally INHERITED — we do not override it, matching
    // spawn.ts which passes childEnv but never unsets PATH, so the shebang
    // `#!/usr/bin/env bash` resolves exactly as in production.
  });
  child.stdout?.on("data", (d: Buffer) => {
    out.value += d.toString();
  });
  // Swallow stderr; the fake child only ever prints its pid + a sleep loop.
  child.stderr?.resume();
  // If the child errors (e.g. missing fake binary) record it; we do not want
  // an unhandled 'error' event to crash the probe.
  child.on("error", () => {
    /* reported via probe() == null */
  });
  return { pid: child.pid ?? -1 };
}

/**
 * Launch the probe *parent* as a separate process (so its death is a real
 * OS-level event, not a synthetic one). The parent spawns the fake child,
 * waits until it is ready, prints both pids, then self-terminates in the
 * requested mode. We capture the parent's stdout to learn the child's pid
 * before the parent dies.
 */
function parentSource(mode: "exit" | "term" | "kill", fakePi: string): string {
  return `
import { spawn } from "node:child_process";
const out = { value: "" };
const child = spawn(${JSON.stringify(fakePi)}, [], {
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout?.on("data", (d: Buffer) => { out.value += d.toString(); });
child.stderr?.resume();
child.on("error", () => {});
await new Promise((resolve) => {
  const deadline = Date.now() + 3000;
  const tick = () => {
    if (/FAKEPI_PID \\d+/.test(out.value)) return resolve();
    if (Date.now() > deadline) return resolve();
    setTimeout(tick, 40);
  };
  tick();
});
console.log("PARENT_PID " + process.pid);
console.log("CHILD_PID " + (child.pid ?? -1));
const mode = ${JSON.stringify(mode)};
if (mode === "term") {
  process.kill(process.pid, "SIGTERM");
} else if (mode === "kill") {
  process.kill(process.pid, "SIGKILL");
} else {
  process.exit(0);
}
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const platform = `${os.platform()}/${os.release()}`;
  console.log("#1023 S1 spike — child-process lifecycle (fake-`pi`, no model calls)");
  console.log(`platform: ${platform}`);
  console.log(`probe pid: ${process.pid}`);
  console.log("spawn options (mirroring extension/src/spawn.ts:184-192):");
  console.log('  spawn(fakePi, [], { shell: false, stdio: ["pipe","pipe","pipe"] })  // no detached flag');
  console.log("");

  // Build the fake `pi` binary: prints its own pid, then sleeps long enough
  // that it is still alive when the parent dies (and when the probe checks).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rukas-spike-a-"));
  const fakePi = path.join(dir, "fakepi");
  const fake = `#!/usr/bin/env bash\necho "FAKEPI_PID $$"\nsleep 300\n`;
  fs.writeFileSync(fakePi, fake, { mode: 0o755 });
  console.log(`fake pi: ${fakePi}`);
  console.log(`workdir: ${dir}`);
  console.log("");

  const modes: { mode: "exit" | "term" | "kill"; label: string; how: string }[] = [
    { mode: "exit", label: "(a) normal exit", how: "process.exit(0)" },
    { mode: "term", label: "(b) SIGTERM", how: 'process.kill(self, "SIGTERM")' },
    { mode: "kill", label: "(c) SIGKILL", how: 'process.kill(self, "SIGKILL")' },
  ];

  for (const { mode, label, how } of modes) {
    const parentSrc = parentSource(mode, fakePi);
    const parentPath = path.join(dir, `parent-${mode}.ts`);
    fs.writeFileSync(parentPath, parentSrc);

    const out = { value: "" };
    // The probe's own child is the PARENT process. We spawn it, read its
    // stdout to learn the grandchild (fake-pi) pid, then let the parent die
    // on its own. We do NOT kill the parent here — the parent self-terminates
    // in `mode`. The probe then waits and `ps`-probes the grandchild.
    const parent = spawn("bun", [parentPath], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    parent.stdout?.on("data", (d: Buffer) => {
      out.value += d.toString();
    });
    parent.stderr?.resume();
    parent.on("error", () => {});

    // Wait for the parent to report both pids (it does this after the fake
    // child is ready, immediately before self-terminating).
    const deadline = Date.now() + 4000;
    while (!/PARENT_PID \d+/.test(out.value) && !/CHILD_PID \d+/.test(out.value)) {
      await sleep(30);
      if (Date.now() > deadline) break;
    }
    await sleep(500); // let the parent's self-terminate actually land

    const parentPid = /PARENT_PID (\d+)/.exec(out.value)?.[1] ?? "?";
    const childPid = /CHILD_PID (\d+)/.exec(out.value)?.[1] ?? "?";

    // Give the OS a beat to reparent / reap, then probe the CHILD.
    await sleep(700);
    const before = childPid !== "?" ? Number(childPid) : -1;
    const after = childPid !== "?" ? probe(Number(childPid)) : null;

    // Also check the parent pid is really gone (sanity: the parent died).
    const parentGone = parentPid !== "?" && probe(Number(parentPid)) === null;

    console.log(`${label}  [parent died by: ${how}]`);
    console.log(`  parent pid: ${parentPid}  (gone after death: ${parentGone ? "yes" : "NO (still listed)"})`);
    console.log(`  child  pid: ${childPid}`);
    if (after) {
      console.log(`  child after parent death: ALIVE  (ppid=${after.ppid}, pgid=${after.pgid}, stat=${after.stat})`);
      console.log(`    → child SURVIVED parent ${label} — orphaned, re-parented to pid ${after.ppid}`);
    } else {
      console.log(`  child after parent death: DEAD (ps: no such process)`);
      console.log(`    → child DIED with parent ${label}`);
    }
    // Best-effort cleanup: kill the surviving child so we don't leak a
    // 300s sleeper between scenarios.
    if (after) {
      try {
        process.kill(Number(childPid), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    console.log("");
  }

  // Summary + cleanup.
  console.log("=== SUMMARY ===");
  console.log("For each death mode, read the `child after parent death:` line above.");
  console.log("ALIVE + ppid=1 (Linux) or ppid=<launchd> (macOS) = orphaned, NOT killed.");
  console.log("DEAD = the kernel reaped the child when the parent died.");
  console.log("");
  console.log("NOTE: a non-Pi parent never registers pi.on(\"session_shutdown\"), so");
  console.log("killAllJobs (async-jobs-lifecycle.ts) is never wired up and never runs.");
  console.log("The only kill path that would fire is an explicit child.kill() — the");
  console.log("question this spike feeds into the EPIC #1018 S4 decision.");
  console.log("");
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

main().catch((e) => {
  console.error("spike failed:", e);
  process.exit(1);
});
