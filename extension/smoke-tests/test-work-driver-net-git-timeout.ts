#!/usr/bin/env bun
/**
 * #1095 — a hung network git call fails within the bound, with its cause.
 *
 * Real git, no stubs: `origin` is an ssh:// URL whose transport is
 * GIT_SSH_COMMAND, pointed at a script that records its argv and sleeps. That
 * is the shape of a forwarded SSH agent that vanished mid-cycle. The driver's
 * `runNetGit` must:
 *   1. reject with NetGitTimeoutError ("network git timed out …") within
 *      PI_ENSEMBLE_GIT_NET_TIMEOUT_MS, not block until the script exits;
 *   2. have run ssh with `-o BatchMode=yes` and `-o ConnectTimeout=30`, the
 *      non-interactive setting that makes a passphrase prompt fail instead of
 *      waiting on /dev/tty.
 *
 * 3. the whole process group is killed on timeout: the script backgrounds a
 *    `sleep` grandchild that inherits the stdout pipe (the ssh-holds-the-pipe
 *    shape). Node's exec would never call back, and the grandchild would
 *    outlive the call. lens-exec's killGroup executor must SIGKILL it.
 */

import { exec } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execp as groupExecp } from "../src/lens-exec.ts";
import { isNetGitTimeout, runNetGit } from "../src/work-driver-net-git.ts";

const execp = promisify(exec);
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

// The verify loop may export GIT_DIR and friends; a leaked GIT_DIR would point
// every git call below at the host repo instead of the fixture.
const isolatedGitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];
const savedEnv: Record<string, string | undefined> = {
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
  PI_ENSEMBLE_GIT_NET_TIMEOUT_MS: process.env.PI_ENSEMBLE_GIT_NET_TIMEOUT_MS,
};
for (const k of isolatedGitVars) savedEnv[k] = process.env[k];
for (const k of isolatedGitVars) Reflect.deleteProperty(process.env, k);
const dir = mkdtempSync(path.join(tmpdir(), "net-git-timeout-"));
const pidFile = path.join(dir, "pid");
const grandPidFile = path.join(dir, "grand-pid");
const argvFile = path.join(dir, "argv");
// Named `ssh`: the driver adds the OpenSSH -o defaults only to a program
// whose basename is ssh (work-driver-net-git.ts netGitEnv).
const script = path.join(dir, "ssh");
writeFileSync(
  script,
  `#!/bin/sh\necho "$@" > "${argvFile}"\necho $$ > "${pidFile}"\nsleep 60 &\necho $! > "${grandPidFile}"\nwait\n`,
);
chmodSync(script, 0o755);

const bare = path.join(dir, "origin.git");
await execp(`git init --bare -q ${JSON.stringify(bare)}`);
const repo = path.join(dir, "work");
await execp(`git init -q ${JSON.stringify(repo)}`);
// ssh:// transport, so git hands the connection to GIT_SSH_COMMAND.
await execp(
  `git -C ${JSON.stringify(repo)} remote add origin ${JSON.stringify(`ssh://nohost${bare}`)}`,
);

process.env.GIT_SSH_COMMAND = script;
process.env.PI_ENSEMBLE_GIT_NET_TIMEOUT_MS = "4000";

console.log("1. hanging remote fails within the bound with the named cause");
const started = Date.now();
let caught: unknown;
try {
  await runNetGit(groupExecp, "git fetch origin main", { cwd: repo });
} catch (err) {
  caught = err;
}
const elapsed = Date.now() - started;
assert(isNetGitTimeout(caught), "rejects with NetGitTimeoutError");
assert(
  caught instanceof Error && caught.message.includes("network git timed out"),
  "message carries 'network git timed out' as the root cause",
);
assert(
  caught instanceof Error && caught.message.includes("git fetch origin main"),
  "message names the command",
);
assert(elapsed < 20_000, `returned in ${elapsed}ms (bound 4000ms, not the 60s sleep)`);
await new Promise((r) => setTimeout(r, 200));
const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8").trim()) : 0;
let grandAlive = false;
if (grandPid > 0) {
  try {
    process.kill(grandPid, 0);
    grandAlive = true;
  } catch {
    grandAlive = false;
  }
}
assert(
  grandPid > 0 && !grandAlive,
  "backgrounded grandchild (holds the pipe) is killed with the group",
);

console.log("2. ssh ran non-interactively");
const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8") : "";
assert(argv.includes("-o BatchMode=yes"), "ssh invoked with -o BatchMode=yes");
assert(argv.includes("-o ConnectTimeout=30"), "ssh invoked with -o ConnectTimeout=30");

// Clean up any survivor (the group kill should already have removed it).
if (existsSync(grandPidFile)) {
  const gp = Number(readFileSync(grandPidFile, "utf8").trim());
  if (Number.isInteger(gp) && gp > 0) {
    try {
      process.kill(gp, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
for (const [k, v] of Object.entries(savedEnv)) {
  if (v === undefined) Reflect.deleteProperty(process.env, k);
  else process.env[k] = v;
}
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll net-git timeout checks passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
