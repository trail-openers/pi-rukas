#!/usr/bin/env bun
/**
 * verify's base probes check the base commit out under the repository, never beside it.
 *
 * A sandboxed cycle may mount only the repository writable. This drives the real baseline probe,
 * through the production executor and real git, in a repository whose parent directory is read-only:
 * the probe has to check the base out and run the tier there. The roster and freeze-check probes
 * build their trees through the same `probeWorktreePath`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { probeTierAtBase, probeWorktreePath } from "../src/lean/verify-baseline.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

const SELF = "test-lean-probe-tree-readonly-parent.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const outer = mkdtempSync(path.join(tmpdir(), "probe-ro-"));
const parent = path.join(outer, "parent");
const repo = path.join(parent, "repo");
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitTestEnv() });
git("init", "-q");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
const baseSha = git("rev-parse", "HEAD").stdout.trim();

for (const kind of ["baseline", "roster", "freeze-check"])
  assert(
    probeWorktreePath(repo, 7, kind).startsWith(`${repo}/.worktrees/`),
    `the ${kind} probe tree is under the repository (${probeWorktreePath(repo, 7, kind)})`,
  );

chmodSync(parent, 0o555);
try {
  let parentWritable = true;
  try {
    mkdirSync(path.join(parent, "probe-write"));
  } catch {
    parentWritable = false;
  }
  if (parentWritable) {
    console.log("SKIP: this user can write to a mode-0555 directory (root?), so a read-only parent cannot be staged");
  } else {
    const real = ((cmd: string, opts?: object) => execp(cmd, opts ?? {})) as unknown as VerifyExec;
    const r = await probeTierAtBase({
      repoRoot: repo,
      baseSha,
      issue: 7,
      cmd: "true",
      timeoutMs: 30_000,
      exec: real,
      frozen: {},
    });
    assert(
      r.status === "green",
      `with the parent read-only, the baseline probe checks the base out and runs (${JSON.stringify(r).slice(0, 200)})`,
    );
  }
} finally {
  chmodSync(parent, 0o755);
  rmSync(outer, { recursive: true, force: true });
}
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
