#!/usr/bin/env bun
/**
 * #1024 (headless S4) — an aborted cycle kills its whole child process tree.
 * The stub pi binary (PI_ENSEMBLE_PI_BIN) is a shell that backgrounds `sleep`
 * and waits, so `sleep` is a GRANDCHILD of the process spawn started. It writes
 * both pids; aborting the signal dispatchCore was given must end the shell AND
 * the grandchild. Killing only the shell leaves `sleep` alive — the failure
 * this test exists to catch.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchHost } from "../src/async-jobs-lifecycle.ts";
import { dispatchCore } from "../src/dispatch.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitGone(pid: number, ms: number): Promise<boolean> {
  return waitFor(() => !alive(pid), ms);
}

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
// The gate runs with live spawn forbidden; this test spawns only the stub.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";

const dir = mkdtempSync(path.join(tmpdir(), "headless-signal-kill-"));
const pidFile = path.join(dir, "child.pid");
const stub = path.join(dir, "pi-stub.sh");
// `--version` (the pi-version probe) must exit at once: otherwise the probe's
// own stub would race the dispatch's pidFile and leak a sleep when the probe kills it.
writeFileSync(
  stub,
  `#!/bin/sh\n[ "$1" = "--version" ] && { echo 0.0.0; exit 0; }\nsleep 600 &\necho "$$ $!" > "${pidFile}"\nwait\n`,
);
chmodSync(stub, 0o755);
process.env.PI_ENSEMBLE_PI_BIN = stub;

const host: DispatchHost = { sendUserMessage: () => {} };
const ac = new AbortController();
const done = dispatchCore(
  host,
  { role: "developer", prompt: "stub", cwd: dir },
  // The headless runner is the only caller that asks for a process group (#1024).
  { signal: ac.signal, skipDeck: true, processGroup: true },
);

const started = await waitFor(() => existsSync(pidFile), 10_000);
assert(started, "the stub child wrote its pids (it is running)");
const [shellPid, pid] = started
  ? readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number)
  : [-1, -1];
assert(shellPid > 0 && alive(shellPid), "the stub shell is alive before the abort");
assert(pid > 0 && alive(pid), "the grandchild sleep is alive before the abort");

ac.abort("signal");
const settled = await Promise.race([
  done.then(
    () => true,
    () => true,
  ),
  sleep(15_000).then(() => false),
]);
assert(settled, "the dispatch settles after its signal aborts");
assert(shellPid > 0 && (await waitGone(shellPid, 5_000)), "the stub shell was killed");
assert(pid > 0 && (await waitGone(pid, 5_000)), "the grandchild sleep was killed with its group");

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
