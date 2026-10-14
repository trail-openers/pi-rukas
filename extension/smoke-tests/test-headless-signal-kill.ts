#!/usr/bin/env bun
/**
 * #1024 (headless S4) — an aborted cycle kills its in-flight child. The stub
 * pi binary (PI_ENSEMBLE_PI_BIN) records its pid and execs `sleep`, so the
 * pid it wrote is the process spawn must kill. Aborting the signal dispatchCore
 * was given must end that process; no pid may survive the dispatch.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatchCore } from "../src/dispatch.ts";
import type { DispatchHost } from "../src/async-jobs-lifecycle.ts";

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

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
// The gate runs with live spawn forbidden; this test spawns only the stub.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";

const dir = mkdtempSync(path.join(tmpdir(), "headless-signal-kill-"));
const pidFile = path.join(dir, "child.pid");
const stub = path.join(dir, "pi-stub.sh");
writeFileSync(stub, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 600\n`);
chmodSync(stub, 0o755);
process.env.PI_ENSEMBLE_PI_BIN = stub;

const host: DispatchHost = { sendUserMessage: () => {} };
const ac = new AbortController();
const done = dispatchCore(
  host,
  { role: "developer", prompt: "stub", cwd: dir },
  { signal: ac.signal, skipDeck: true },
);

const started = await waitFor(() => existsSync(pidFile), 10_000);
assert(started, "the stub child wrote its pid (it is running)");
const pid = started ? Number(readFileSync(pidFile, "utf8").trim()) : -1;
assert(pid > 0 && alive(pid), "the stub child is alive before the abort");

ac.abort("signal");
const settled = await Promise.race([
  done.then(() => true, () => true),
  sleep(15_000).then(() => false),
]);
assert(settled, "the dispatch settles after its signal aborts");
assert(pid > 0 && !alive(pid), "no leftover pid: the in-flight child was killed");

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
