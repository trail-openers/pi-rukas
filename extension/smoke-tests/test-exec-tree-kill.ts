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

  // ── #1427 — a killed run reports WHICH pid's group it took down ───────
  // The hang reporter walks that pid's tree; without the field it can only say
  // "timed out", which is the report the operator cannot act on.
  {
    const g = gate("leader");
    const err = await execTree(g.cmd, { timeout: 400 }).then(
      () => undefined,
      (e: ExecTreeError) => e,
    );
    const pid = await grandchildPid(g.pidFile);
    expect(err?.killed === true, "treePid: a timeout rejects with killed=true");
    expect(
      typeof err?.treePid === "number" && err.treePid > 0 && err.treePid !== pid,
      `treePid: the killed leader pid is reported (${err?.treePid})`,
    );
    expect(await goneWithin(pid, 2000), "treePid: the grandchild is gone after the timeout");
  }

  // ── A non-killed failure reports no leader pid ─────────────────────────
  // The hang report is only ever built from a run the executor actually
  // killed; a failing run must not acquire a claim about processes it held
  // briefly and normally.
  {
    const fail = await execTree("exit 3").then(
      () => undefined,
      (e: ExecTreeError) => e,
    );
    expect(fail?.treePid === undefined, "treePid: a non-zero exit reports no gate pid");
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

    // ── #1427: an overflow kill is NOT a timeout kill ─────────────────
    // Both kill paths set `killed`, so `killed` cannot be the hang gate: a
    // run that printed too much is reported as hung otherwise, and the cap
    // becomes `verify-timeout` for a gate that simply produced a wall of text.
    expect(big?.killed === true, "overflow: the run was still killed");
    expect(
      big?.timedOutKill === false,
      `overflow: NOT reported as a timeout kill (timedOutKill=${String(big?.timedOutKill)})`,
    );
    expect(
      big?.overflow === "stdout",
      `overflow: names the stream that overflowed (${String(big?.overflow)})`,
    );
    expect(
      big?.treePid === undefined,
      "overflow: reports NO gate pid, so no caller builds a hang report from it",
    );

    const slow = await execTree("sleep 5", { timeout: 80, killGraceMs: 40 }).then(
      () => undefined,
      (e: ExecTreeError) => e,
    );
    expect(slow?.timedOutKill === true, "timeout: reported as a timeout kill");
    expect(
      typeof slow?.treePid === "number",
      `timeout: still reports the group it killed (${String(slow?.treePid)})`,
    );
    expect(slow?.overflow === undefined, "timeout: names no overflow");

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
