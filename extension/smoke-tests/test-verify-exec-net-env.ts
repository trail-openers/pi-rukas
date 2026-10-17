#!/usr/bin/env bun
/**
 * #1095 review — the verify-gate executor (work-driver-verify.ts `execp`) is
 * the production default for the branch-step mechanized fetch and the
 * handoff-consolidate fetch. A network call routed through it must carry the
 * non-interactive env (BatchMode via GIT_SSH_COMMAND) and the group-killing
 * executor, exactly as exec.ts's execp does.
 *
 * Real git: origin is ssh://, GIT_SSH_COMMAND points at a script named `ssh`
 * that records its argv and exits non-zero at once (no network needed).
 */

import { exec } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runNetGit } from "../src/work-driver-net-git.ts";
import { execp as verifyExecp } from "../src/work-driver-verify.ts";

const execp = promisify(exec);
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

const savedEnv: Record<string, string | undefined> = {
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
  GIT_SSH: process.env.GIT_SSH,
};
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
  savedEnv[k] = process.env[k];
  Reflect.deleteProperty(process.env, k);
}
delete process.env.GIT_SSH;

const dir = mkdtempSync(path.join(tmpdir(), "verify-exec-net-"));
const argvFile = path.join(dir, "argv");
const script = path.join(dir, "ssh");
writeFileSync(script, `#!/bin/sh\necho "$@" > "${argvFile}"\nexit 1\n`);
chmodSync(script, 0o755);

const repo = path.join(dir, "work");
await execp(`git init -q ${JSON.stringify(repo)}`);
await execp(
  `git -C ${JSON.stringify(repo)} remote add origin ${JSON.stringify(`ssh://nohost${dir}/origin.git`)}`,
);
process.env.GIT_SSH_COMMAND = script;

console.log("1. argv-form network call via the verify executor carries BatchMode");
let argvErr: unknown;
try {
  await runNetGit(verifyExecp, "git", { cwd: repo, argv: ["fetch", "origin", "main"] });
} catch (err) {
  argvErr = err;
}
assert(argvErr !== undefined, "the fetch fails (script exits 1) and rejects");
const argv1 = existsSync(argvFile) ? readFileSync(argvFile, "utf8") : "";
assert(argv1.includes("-o BatchMode=yes"), "ssh invoked with -o BatchMode=yes");
assert(argv1.includes("-o ConnectTimeout=30"), "ssh invoked with -o ConnectTimeout=30");

console.log("2. shell-form network call via the verify executor carries BatchMode");
rmSync(argvFile, { force: true });
try {
  await runNetGit(verifyExecp, `git fetch origin "main"`, { cwd: repo });
} catch {
  // expected: the script exits 1
}
const argv2 = existsSync(argvFile) ? readFileSync(argvFile, "utf8") : "";
assert(argv2.includes("-o BatchMode=yes"), "shell form: ssh invoked with -o BatchMode=yes");

console.log("3. a non-network call through the verify executor is unchanged");
const plain = await verifyExecp("echo hi", {});
assert(plain.stdout.trim() === "hi", "classic shell path still runs and returns stdout");

for (const [k, v] of Object.entries(savedEnv)) {
  if (v === undefined) Reflect.deleteProperty(process.env, k);
  else process.env[k] = v;
}
rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0 ? "\nAll verify-executor network env checks passed" : `\n${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
