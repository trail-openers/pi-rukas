/**
 * Offline smoke: a gate killed at its timeout takes its children with it.
 *
 * `child_process.exec`'s timeout signals the shell alone, so a timed-out
 * verify / smoke command left every descendant running — in a pid-limited
 * container, the route from one slow gate to `fork: Resource temporarily
 * unavailable` for the rest of the cycle. This spawns a REAL shell that
 * forks a long-sleeping grandchild, times it out through the driver's
 * production executor, and asserts the grandchild is gone.
 *
 * Both directions: the same command through `promisify(exec)` must leave
 * the grandchild alive, or this test proves nothing about the fix.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-exec-tree-kill.ts
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type ExecTreeError, execTree } from "../src/exec-tree.ts";
import { execp } from "../src/work-driver-verify.ts";

let failures = 0;
function expect(cond: boolean, label: string) {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}`);
    failures += 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exec-tree-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the pid is gone (a killed orphan is reaped asynchronously). */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(25);
  }
  return !alive(pid);
}

/**
 * A gate-shaped command: the shell forks a grandchild that outlives it,
 * records its pid, and waits. `prelude` runs inside the grandchild first.
 */
function gate(name: string, prelude = ""): { cmd: string; pidFile: string } {
  const pidFile = path.join(tmp, `${name}.pid`);
  const script = path.join(tmp, `${name}.sh`);
  fs.writeFileSync(script, `bash -c '${prelude}echo $$ > ${pidFile}; sleep 60' &\nwait\n`);
  return { cmd: `bash ${script}`, pidFile };
}

async function grandchildPid(pidFile: string): Promise<number> {
  for (let i = 0; i < 80 && !fs.existsSync(pidFile); i++) await sleep(25);
  return Number(fs.readFileSync(pidFile, "utf8").trim());
}

async function main() {
  // ── Control: promisify(exec) leaks the grandchild ─────────────────────
  {
    const g = gate("control");
    const err = await promisify(exec)(g.cmd, { timeout: 400 }).then(
      () => undefined,
      (e: ExecTreeError) => e,
    );
    const pid = await grandchildPid(g.pidFile);
    expect(err?.killed === true, "control: exec reports the timeout");
    expect(alive(pid), "control: exec's timeout leaves the grandchild running");
    process.kill(pid, "SIGKILL");
  }

  // ── The driver's verify executor kills the tree ───────────────────────
  {
    const g = gate("driver");
    const started = Date.now();
    const err = await execp(g.cmd, { timeout: 400 }).then(
      () => undefined,
      (e: ExecTreeError) => e,
    );
    const pid = await grandchildPid(g.pidFile);
    expect(err?.killed === true, "execp: a timeout rejects with killed=true");
    expect(Date.now() - started < 3000, "execp: the rejection is prompt");
    expect(await goneWithin(pid, 2000), "execp: the grandchild is gone after the timeout");
  }

  // ── A descendant that ignores SIGTERM is SIGKILLed after the grace ────
  {
    const g = gate("stubborn", `trap "" TERM; `);
    const err = await execTree(g.cmd, { timeout: 400, killGraceMs: 300 }).then(
      () => undefined,
      (e: ExecTreeError) => e,
    );
    const pid = await grandchildPid(g.pidFile);
    expect(err?.killed === true, "stubborn: the timeout still rejects");
    expect(await goneWithin(pid, 3000), "stubborn: a SIGTERM-ignoring grandchild is SIGKILLed");
  }

  // ── A descendant that left the group cannot hold the driver ───────────
  // (`setsid` is util-linux; macOS has none, and the case is skipped there.)
  if (await execTree("command -v setsid").catch(() => undefined)) {
    const pidFile = path.join(tmp, "escaped.pid");
    const started = Date.now();
    const err = await execTree(`setsid bash -c 'echo $$ > ${pidFile}; sleep 60' & wait`, {
      timeout: 400,
      killGraceMs: 300,
    }).then(
      () => undefined,
      (e: ExecTreeError) => e,
    );
    expect(err?.killed === true, "escaped: the timeout rejects");
    expect(Date.now() - started < 3000, "escaped: an open pipe does not delay the rejection");
    if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
  }

  // ── The exec contract callers read is unchanged ───────────────────────
  {
    const ok = await execTree("printf out; printf err >&2");
    expect(ok.stdout === "out" && ok.stderr === "err", "success resolves {stdout, stderr}");

    const fail = await execTree("printf out; printf err >&2; exit 3").then(
      () => undefined,
      (e: ExecTreeError) => e,
    );
    expect(fail?.code === 3 && fail.killed === false, "a non-zero exit rejects with its code");
    expect(fail?.stdout === "out" && fail.stderr === "err", "the rejection carries both streams");
    expect(
      fail?.message.startsWith("Command failed: ") === true && fail.message.includes("err"),
      "the message is exec's `Command failed: <cmd>\\n<stderr>`",
    );

    const big = await execTree("head -c 5000 /dev/zero | tr '\\0' x", { maxBuffer: 1000 }).then(
      () => undefined,
      (e: ExecTreeError) => e,
    );
    expect(big?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "maxBuffer overflow keeps its code");

    const cwd = await execTree("pwd", { cwd: tmp });
    expect(fs.realpathSync(cwd.stdout.trim()) === fs.realpathSync(tmp), "cwd is honoured");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n✓ exec-tree kill smoke passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
