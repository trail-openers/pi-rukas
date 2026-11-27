#!/usr/bin/env bun
/**
 * The `resetWorktreeToBase` submodule initialisation, called on the primitive directly.
 *
 * `test-lean-specify-submodule.ts` holds the step-level cases (a)–(e): what a specify
 * run does with a gitlink, with no gitlink, and when the recorded source is gone. The
 * cases here call the reset PRIMITIVE, which is where the initialisation lives, so the
 * per-path files are consequences rather than separate promises.
 *
 *   (f) the reset re-populates a submodule its OWN `clean -fdx` emptied — the property
 *       every caller of the reset depends on, and the one a reset whose initialisation
 *       sat outside it does not have;
 *   (g) the retired `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` is ignored: the reset still
 *       asks git to populate the submodule, and leaves it populated.
 *
 * Real temp repos, real git, the real `execp`; nothing stubbed but the model these
 * steps do not use.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { resetWorktreeToBase } from "../src/lean/specify-reset.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv, trackedTempDir } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const SUB = "vendor/lib";
const INSIDE = `${SUB}/lib`;

/** The env the reset's git calls need: an identity, and the local-path `file` transport. */
const env = {
  ...gitTestEnv(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};

const git = (dir: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
};

const put = (dir: string, rel: string, text: string): void => {
  const target = path.join(dir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
};

/** A standalone repo to mount as a submodule, with one committed file. */
function remoteRepo(): string {
  const remote = trackedTempDir("reset-off-remote-");
  git(remote, "init", "-q", "-b", "main");
  put(remote, "lib", "the submodule's own content\n");
  git(remote, "add", "-A");
  git(remote, "commit", "-q", "-m", "the submodule's content");
  return remote;
}

/** A repo whose BASE commit carries a submodule at `vendor/lib` sourced from `remote`. */
function repoWithSubmodule(remote: string): { repoRoot: string; baseSha: string } {
  const repoRoot = trackedTempDir("reset-off-");
  git(repoRoot, "init", "-q", "-b", "main");
  put(repoRoot, "src/retry.ts", "export const retry = () => {};\n");
  put(repoRoot, "tests/AC1-retry.test.sh", "#!/bin/sh\nexit 1\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  git(
    repoRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    "--force",
    remote,
    SUB,
  );
  git(repoRoot, "commit", "-q", "-m", "base with a vendored submodule");
  return { repoRoot, baseSha: git(repoRoot, "rev-parse", "HEAD") };
}

/** A detached worktree of `repoRoot` at `sha`. */
function worktreeAt(repoRoot: string, sha: string, name: string): string {
  const wt = path.join(repoRoot, ".worktrees", name);
  git(repoRoot, "worktree", "add", "-q", "--detach", wt, sha);
  return wt;
}

/** The step's git calls, watched without replacing the executor. */
function watcher(): { exec: ExecFn; argvs: string[][] } {
  const argvs: string[][] = [];
  return {
    argvs,
    exec: async (cmd, o) => {
      if (cmd === "git" && o?.argv !== undefined) argvs.push([...o.argv]);
      return execp(cmd, { ...o, env: { ...env, ...(o?.env ?? {}) } });
    },
  };
}

const submoduleCalls = (argvs: readonly (readonly string[])[]): readonly (readonly string[])[] =>
  argvs.filter((argv) => argv.includes("submodule") || argv.includes(".gitmodules"));

// ── (f) the reset re-populates what its own clean emptied
{
  // No hand-emptied tree here: `resetWorktreeToBase`'s own `clean -fdx` is the
  // de-populator, so the case cannot pass by the fixture leaving content behind.
  const remote = remoteRepo();
  const { repoRoot, baseSha } = repoWithSubmodule(remote);
  const wt = worktreeAt(repoRoot, baseSha, "lean-150");
  const { exec } = watcher();
  let threw: Error | undefined;
  try {
    await resetWorktreeToBase(exec, wt, baseSha, "");
  } catch (err) {
    threw = err as Error;
  }
  assert(
    threw === undefined,
    `(f) preparing the fresh tree does not throw (${threw?.message?.split("\n")[0] ?? "clean"})`,
  );
  assert(
    existsSync(path.join(wt, INSIDE)) === true,
    "(f) the prepared tree has the submodule populated",
  );
  // The sabotage: empty it as a stale tree would be, then reset again. A reset whose
  // initialisation sat OUTSIDE it leaves the directory empty and hands the child a
  // test it cannot collect.
  rmSync(path.join(wt, SUB), { recursive: true, force: true });
  assert(
    existsSync(path.join(wt, INSIDE)) === false,
    "(f) and the fixture did empty it before the reset that has to undo that",
  );
  let threw2: Error | undefined;
  try {
    await resetWorktreeToBase(exec, wt, baseSha, "");
  } catch (err) {
    threw2 = err as Error;
  }
  assert(
    threw2 === undefined,
    `(f) resetting a tree whose submodule was emptied does not throw (${threw2?.message?.split("\n")[0] ?? "clean"})`,
  );
  assert(
    existsSync(path.join(wt, INSIDE)) === true,
    "(f) and the reset left the submodule populated",
  );
}

// ── (g) the retired switch at "0" is ignored
{
  const remote = remoteRepo();
  const { repoRoot, baseSha } = repoWithSubmodule(remote);
  const wt = worktreeAt(repoRoot, baseSha, "lean-154");
  const { exec, argvs } = watcher();
  let threw: Error | undefined;
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    try {
      await resetWorktreeToBase(exec, wt, baseSha, "");
    } catch (err) {
      threw = err as Error;
    }
  });
  assert(
    threw === undefined && submoduleCalls(argvs).length > 0,
    `(g) "0" still asks git to populate the submodule (${threw?.message?.split("\n")[0] ?? JSON.stringify(submoduleCalls(argvs))})`,
  );
  assert(existsSync(path.join(wt, INSIDE)) === true, "(g) and it left the submodule populated");
}

process.exit(exit);
