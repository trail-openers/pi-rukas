#!/usr/bin/env bun
/**
 * #1095 — a network git timeout at the two best-effort fetch sites fails with
 * its named cause; a non-timeout fetch error still takes the local-ref fallback
 * (#533). Real git: origin is an ssh:// URL whose transport is a script that
 * sleeps (the vanished-agent shape). Non-timeout: origin is a missing local
 * path, which fails at once.
 *
 * Sites: work-driver-branch-ops.ts (runBranchViaOpsDispatch, before any
 * dispatch) and work-driver-handoff-consolidate-branch.ts
 * (reconcileHandoffConsolidateBranch).
 */

import { exec } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execp as groupExecp } from "../src/exec.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runBranchViaOpsDispatch } from "../src/work-driver-branch-ops.ts";
import { reconcileHandoffConsolidateBranch } from "../src/work-driver-handoff-consolidate-branch.ts";
import { isNetGitTimeout } from "../src/work-driver-net-git.ts";
import type { WorkState } from "../src/workflow-state.ts";

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
  PI_ENSEMBLE_GIT_NET_TIMEOUT_MS: process.env.PI_ENSEMBLE_GIT_NET_TIMEOUT_MS,
};
// A leaked GIT_DIR would point every git call below at the host repo.
const isolatedGitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];
for (const k of isolatedGitVars) {
  savedEnv[k] = process.env[k];
  Reflect.deleteProperty(process.env, k);
}

const dir = mkdtempSync(path.join(tmpdir(), "net-git-timeout-sites-"));
const hangScript = path.join(dir, "hang-ssh.sh");
writeFileSync(hangScript, "#!/bin/sh\nsleep 60\n");
chmodSync(hangScript, 0o755);

// A repo with a commit and refs/remotes/origin/main, so detectMainline resolves
// and the fetch is the call under test.
const repo = path.join(dir, "work");
await execp(`git init -q -b main ${JSON.stringify(repo)}`);
await execp(
  `git -C ${JSON.stringify(repo)} -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init`,
);
await execp(`git -C ${JSON.stringify(repo)} update-ref refs/remotes/origin/main HEAD`);

// No verifyExecFn injected: the production default executor is the one under test.
const ctx = { repoRoot: repo } as unknown as DriverContext;
const base = {} as unknown as WorkState;

process.env.PI_ENSEMBLE_GIT_NET_TIMEOUT_MS = "4000";

console.log("1. ops-fallback fetch (branch step) — timeout fails with the named cause");
await execp(
  `git -C ${JSON.stringify(repo)} remote add origin ${JSON.stringify(`ssh://nohost${dir}/origin.git`)}`,
);
process.env.GIT_SSH_COMMAND = hangScript;
let branchErr: unknown;
try {
  await runBranchViaOpsDispatch(ctx, base, [], Date.now());
} catch (err) {
  branchErr = err;
}
assert(isNetGitTimeout(branchErr), "runBranchViaOpsDispatch rejects with NetGitTimeoutError");
assert(
  branchErr instanceof Error && branchErr.message.includes("network git timed out"),
  "the rejection names the timeout cause",
);

console.log("2. handoff-consolidate fetch — timeout fails with the named cause");
let consolidateErr: unknown;
try {
  await reconcileHandoffConsolidateBranch(groupExecp, repo, "feature/issue-1-x");
} catch (err) {
  consolidateErr = err;
}
assert(isNetGitTimeout(consolidateErr), "reconcileHandoffConsolidateBranch rejects on timeout");

console.log("3. non-timeout fetch error still falls back to local refs");
await execp(
  `git -C ${JSON.stringify(repo)} remote set-url origin ${JSON.stringify(path.join(dir, "missing.git"))}`,
);
let fallbackResult: unknown = "not-run";
let fallbackErr: unknown;
try {
  fallbackResult = await reconcileHandoffConsolidateBranch(groupExecp, repo, "feature/issue-1-x");
} catch (err) {
  fallbackErr = err;
}
assert(fallbackErr === undefined, "a failed (non-timeout) fetch does not throw");
assert(
  fallbackResult === undefined,
  "…and the local origin/main is used (no local branch → no-op)",
);

for (const k of Object.keys(savedEnv)) {
  const v = savedEnv[k];
  if (v === undefined) Reflect.deleteProperty(process.env, k);
  else process.env[k] = v;
}
rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0 ? "\nAll net-git timeout site checks passed" : `\n${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
