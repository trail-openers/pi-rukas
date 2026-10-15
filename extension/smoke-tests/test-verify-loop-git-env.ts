#!/usr/bin/env bun
/**
 * verify-loop.sh must not let a caller's GIT_DIR reach the tests.
 *
 * Smoke tests build throwaway repositories (`git init --bare <tmp>`,
 * `git config user.email …`). With GIT_DIR set — as git does for every hook —
 * those commands rewrite the CALLER's repository: `core.bare = true` and a
 * fake identity in its config, after which no worktree of it works. The
 * runner drops git's repository-locating variables first.
 *
 * This drives the real runner with GIT_DIR pointing at a victim repository
 * and a fixture test that does what the real tests do.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const RUNNER = path.join(import.meta.dirname, "lib", "verify-loop.sh");
const dir = mkdtempSync(path.join(tmpdir(), "verify-loop-git-env-"));
// The child git calls below must not inherit a GIT_DIR of our own.
const clean = { ...process.env };
for (const k of Object.keys(clean)) if (k.startsWith("GIT_")) delete clean[k];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: clean }).trim();

try {
  const victim = path.join(dir, "victim");
  mkdirSync(victim);
  git(victim, "init", "-q");
  git(victim, "config", "user.email", "owner@example.com");

  // What the real tests do: a bare origin and an identity in a temp clone.
  const fixture = path.join(dir, "fixture-test.ts");
  writeFileSync(
    fixture,
    [
      'import { execFileSync } from "node:child_process";',
      'import { mkdtempSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      'import path from "node:path";',
      'const d = mkdtempSync(path.join(tmpdir(), "fixture-repo-"));',
      'execFileSync("git", ["init", "-q", "--bare", path.join(d, "origin.git")]);',
      'execFileSync("git", ["init", "-q", path.join(d, "root")]);',
      'execFileSync("git", ["config", "user.email", "t@t"], { cwd: path.join(d, "root") });',
      'console.log("fixture ran");',
      "",
    ].join("\n"),
  );

  const run = spawnSync("bash", [RUNNER, fixture], {
    encoding: "utf8",
    // GIT_DIR alone: with GIT_WORK_TREE as well, `git init --bare` refuses to
    // run and the damage does not happen.
    env: { ...clean, GIT_DIR: path.join(victim, ".git") },
  });
  assert(run.status === 0, `the runner passes the fixture (status ${run.status})`);
  assert(
    git(victim, "config", "--get", "core.bare") === "false",
    "the caller's repository is not turned bare",
  );
  assert(
    git(victim, "config", "--get", "user.email") === "owner@example.com",
    "the caller's identity is not overwritten",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
