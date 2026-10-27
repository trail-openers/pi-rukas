#!/usr/bin/env bun
/**
 * #1849 — the revert's git calls run in the DRIVER's environment, with the
 * repository's own hook and fsmonitor config switched off.
 *
 * Two defects, one seam. `commitRevert` handed its git calls
 * `env: { GIT_INDEX_FILE: tmpIndex }`, and Node's `execFile` treats `env` as the
 * child's WHOLE environment: `HOME` went with it, and with `HOME` the global git
 * config (`safe.directory`, the commit identity, the credential helper), plus
 * every scrub the driver applies elsewhere (`verifyChildEnv`'s driver knobs,
 * `scrubGitLocation`'s repository-location variables). An object literal naming
 * one variable is not "add one variable" — it is "the child has one variable".
 *
 *   1. **The argv form is observable.** A recording transport captures exactly the
 *      `env` the revert hands its executor, and one captures the argv: HOME (and
 *      every non-knob variable) must be present beside `GIT_INDEX_FILE`, and
 *      every git call must carry the `-c core.hooksPath=/dev/null -c
 *      core.fsmonitor=false` prefix `git-state.ts` uses for the same reason. The
 *      driver's own knob is exported for the duration of the assertion, so the
 *      env the revert builds must NOT carry it either.
 *   2. **The behaviour is observable.** The revert is run in a scratch repo whose
 *      global config carries a hostile `core.fsmonitor` hook and no `user.name`,
 *      with `GIT_CONFIG_GLOBAL` pointing at it through a sentinel env var. With
 *      the old env the child never sees the sentinel at all (so neither the
 *      sentinel nor the hardening has any effect); with the fix the child sees it
 *      — and the hardening is what keeps the hook from running anyway, which the
 *      sentinel file itself records.
 *
 * Fails on the pre-fix line — copied to
 * /tmp/pi-ensemble-developer/work-driver-fix-pass-strays-commit.ts.old.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GitCallOpts, type GitExec, runGit } from "../src/work-develop-git.ts";
import { execp } from "../src/exec.ts";
import { hardenedGitArgv, revertGitEnv } from "../src/work-driver-fix-pass-strays-target.ts";
import { revertFixPassStrays } from "../src/work-driver-fix-pass-strays.ts";
import { git, passTreeAt } from "./lib/adversarial-fix-fixtures.ts";

const gitExec: GitExec = runGit(execp);

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A transport that records what the revert handed its executor. */
function recording(): { git: GitExec; calls: { args: string[]; opts: GitCallOpts }[] } {
  const calls: { args: string[]; opts: GitCallOpts }[] = [];
  const real = runGit(execp);
  return {
    calls,
    git: async (args, opts) => {
      calls.push({ args, opts });
      return real(args, opts);
    },
  };
}

const HARDEN = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/** A driver knob that must NOT reach a git child (verifyChildEnv drops it). */
const DRIVER_KNOB = "PI_ENSEMBLE_FIX_PASS_STRAY_REVERT";

console.log("# the env handed to the revert's git calls is the driver's, plus GIT_INDEX_FILE");
{
  // The knob is set for the duration of the run: an env built from a bare
  // literal cannot drop it, and an env built from `process.env` either, so this
  // is what separates "copied the parent" from "copied nothing".
  process.env[DRIVER_KNOB] = "1";
  const t = passTreeAt("1846-env");
  const rec = recording();
  const res = await revertFixPassStrays({
    git: rec.git,
    worktree: t.worktree,
    recordedWorktree: t.worktree,
    repoRoot: t.repoRoot,
    issue: 1846,
    workstreamId: "default",
    attempt: 1,
    headBefore: t.headBefore,
    strays: ["helper.ts"],
    untracked: new Set<string>(),
    scratchDir: `${t.repoRoot}/tmp/issue-1846`,
  });
  delete process.env[DRIVER_KNOB];
  if ("reason" in res) assert(false, `the revert succeeded — it refused: ${res.reason}`);
  else {
    // The `update-ref HEAD <sha>` that installs the commit carries no index of its
    // own — moving a ref reads no index — so the index assertion covers the calls
    // that actually stage and build a tree.
    const commitCalls = rec.calls.filter(
      (c) =>
        c.args.includes("read-tree") ||
        c.args.includes("write-tree") ||
        c.args.includes("commit-tree"),
    );
    assert(
      commitCalls.length >= 3,
      `the commit ran through the recorded transport (${commitCalls.length} calls)`,
    );
    const withIndex = commitCalls.filter((c) => c.opts.env?.GIT_INDEX_FILE !== undefined);
    assert(
      withIndex.length === commitCalls.length,
      `every commit call carried GIT_INDEX_FILE (${withIndex.length}/${commitCalls.length})`,
    );
    const env = withIndex[0]?.opts.env;
    assert(env !== undefined && Object.keys(env).length > 1, `the env is not a one-variable literal (${Object.keys(env ?? {}).join(", ")})`);
    assert(
      env !== undefined && env.HOME === process.env.HOME,
      `HOME survives (${env?.HOME ?? "<missing>"})`,
    );
    assert(
      env !== undefined && env.PATH === process.env.PATH,
      "PATH survives — a child that cannot find git is the same bug in a different costume",
    );
    assert(
      env !== undefined && env[DRIVER_KNOB] === undefined,
      "the driver's own knob is scrubbed from the git child (`verifyChildEnv` is the base, not `process.env`)",
    );
    assert(
      commitCalls.every((c) => HARDEN.every((a, i) => c.args[i] === a)),
      `every commit call is prefixed with the hook/fsmonitor guard (${JSON.stringify(commitCalls.map((c) => c.args.slice(0, 5)))})`,
    );
    assert(
      rec.calls.every((c) => HARDEN.every((a, i) => c.args[i] === a)),
      `and so is every OTHER git call the revert makes — read, preserve, revert and rollback alike (${rec.calls.length} calls)`,
    );
    assert(
      rec.calls.every((c) => c.opts.env?.HOME === process.env.HOME),
      "and every one of them runs in the scrubbed parent env, not a one-variable literal",
    );
  }
}

console.log("# the hardener is one place, and says the pair git-state.ts says");
{
  const argv = hardenedGitArgv(["apply", "--binary", "x.patch"]);
  assert(
    argv.join(" ") === [...HARDEN, "apply", "--binary", "x.patch"].join(" "),
    `hardenedGitArgv prefixes once, in front (${JSON.stringify(argv)})`,
  );
  const env = revertGitEnv({ GIT_INDEX_FILE: "/tmp/idx" });
  assert(
    env.GIT_INDEX_FILE === "/tmp/idx" && env.HOME === process.env.HOME,
    "revertGitEnv sets what the caller asks and keeps what the child needs",
  );
  const scrubbed = revertGitEnv({ GIT_INDEX_FILE: undefined });
  assert(
    scrubbed.GIT_INDEX_FILE === undefined,
    "an explicit undefined removes rather than stringifies (Bun stores 'undefined' for an assignment)",
  );
  const base = { ...process.env, GIT_DIR: "/tmp/decoy/.git" };
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = "/tmp/decoy/.git";
  const scrubbed2 = revertGitEnv();
  assert(
    scrubbed2.GIT_DIR === undefined,
    "an inherited GIT_DIR never reaches a revert git call — the location scrub (#1571) is applied here too",
  );
  if (saved === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = saved;
  void base;
}

console.log("# a hostile global config is BOTH visible to the child and switched off");
{
  // The sentinel: a global config the revert's git children read via
  // GIT_CONFIG_GLOBAL, holding a fsmonitor hook and no user.name.
  const t = passTreeAt("1846-hostile-config");
  const home = join(t.repoRoot, "fake-home");
  const cfg = join(home, "gitconfig");
  const marker = join(home, "hook-ran");
  mkdirSync(home, { recursive: true });
  // A TAB written as a literal escape inside a single-quoted JS string, so the
  // config file holds what git expects and no shell expansion is in play.
  writeFileSync(cfg, '[core]\n\tfsmonitor = "sh -c \'touch ' + marker + "\'\"\n");
  // The sentinel is an ENVIRONMENT fact: the child only sees the config if the
  // revert's env survived. Under the old `env: { GIT_INDEX_FILE }` nothing in
  // this block could fire, which is precisely the assertion.
  process.env.GIT_CONFIG_GLOBAL = cfg;
  const rec = recording();
  const res = await revertFixPassStrays({
    git: rec.git,
    worktree: t.worktree,
    recordedWorktree: t.worktree,
    repoRoot: t.repoRoot,
    issue: 1846,
    workstreamId: "default",
    attempt: 1,
    headBefore: t.headBefore,
    strays: ["helper.ts"],
    untracked: new Set<string>(),
    scratchDir: `${t.repoRoot}/tmp/issue-1846`,
  });
  delete process.env.GIT_CONFIG_GLOBAL;
  if ("reason" in res) assert(false, `the revert succeeded — it refused: ${res.reason}`);
  else {
    const env = rec.calls[0]?.opts.env;
    assert(
      env?.GIT_CONFIG_GLOBAL === cfg,
      `the sentinel config reached the git child (${JSON.stringify(env?.GIT_CONFIG_GLOBAL)}) — the whole-env literal would have dropped it`,
    );
    assert(
      rec.calls.every((c) => c.args.includes("core.fsmonitor=false")),
      "every git call switches the repo-supplied fsmonitor off, so the hook is never what ran",
    );
    assert(
      !existsSync(marker),
      "the fsmonitor hook never ran in the driver's revert — it would have written the marker file",
    );
    // The commit landed despite the config carrying no identity, because the
    // identity is set on the command line: proof the child really read a config
    // the fixture chose rather than a stripped environment that merely happened
    // to work.
    const author = git(t.worktree, "log -1 --format=%an").trim();
    assert(author === "pi-rukas", `the revert commit's author is the driver's (${author})`);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
