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
import { GIT_LOCATION_VARS } from "../src/git-env.ts";

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

// ── The runner scrubs the WHOLE set, not the eight names it first listed.
//
// Same shape as the victim case above: inject the hostile variable into the
// RUNNER's environment and ask what the test child actually sees. A child of
// this process is no evidence at all — by the time it was spawned the parent
// had already scrubbed (`clean` above), so a runner that scrubbed nothing would
// still report a clean child. The child the runner starts is the one under test.
//
// Five names — `GIT_IMPLICIT_WORK_TREE`, `GIT_SHALLOW_FILE`, `GIT_GRAFT_FILE`,
// `GIT_NO_REPLACE_OBJECTS`, `GIT_REPLACE_REF_BASE` — sat outside the original
// list, each of which redirects a real read (object store, grafts, replace refs).
//
// Asserted against `GIT_LOCATION_VARS` rather than a list typed here, so the
// gate cannot drift from the set production scrubs: a name added on one side
// and not the other fails naming the leak, instead of surviving as stray
// commits in whoever's repository the variable names.
{
  // Its own temp dir: the block above removes `dir` in its `finally`.
  const probeRoot = mkdtempSync(path.join(tmpdir(), "verify-loop-leak-"));
  const leakProbe = path.join(probeRoot, "leak-probe.ts");
  writeFileSync(
    leakProbe,
    [
      `const names = ${JSON.stringify([...GIT_LOCATION_VARS])};`,
      "console.log('LEAK=' + names.filter((n) => process.env[n] !== undefined).join(','));",
      "",
    ].join("\n"),
  );
  const leaked: string[] = [];
  // One name per run: `unset` takes the whole list at once, but a single-name
  // run names WHICH one leaked, and a batched run would only ever report the
  // first — the same off-by-one that kept five names invisible for their whole
  // life inside a list that looked complete.
  for (const name of GIT_LOCATION_VARS) {
    const probe = spawnSync("bash", [RUNNER, leakProbe], {
      encoding: "utf8",
      env: { ...clean, [name]: path.join(probeRoot, "must-not-be-read") },
    });
    const leakLine = (probe.stdout ?? "").split("\n").find((l) => l.startsWith("LEAK="));
    if (leakLine === undefined) {
      leaked.push(`${name}(no output — probe did not run)`);
    } else if (leakLine !== "LEAK=") {
      leaked.push(leakLine.slice(5));
    }
  }
  rmSync(probeRoot, { recursive: true, force: true });
  assert(
    leaked.length === 0,
    `the runner leaves no git location variable in a test child (${GIT_LOCATION_VARS.length} names checked, leaked: ${JSON.stringify(leaked)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
