#!/usr/bin/env bun
/**
 * The `resetWorktreeToBase` arms of #2212's submodule switch, off.
 *
 * `test-lean-specify-submodule.ts` holds the step-level cases (a)–(e): what a specify
 * run does with a gitlink, with no gitlink, and when the recorded source is gone. The
 * two cases here call the reset PRIMITIVE directly, which is where the gate's actual
 * claim lives — the switch sits inside `resetWorktreeToBase`, not at its six call
 * sites, so proving it there is what makes the per-path files
 * (`test-lean-submodule-reset-off.ts`) consequences rather than separate promises.
 *
 *   (f) the reset re-populates a submodule its OWN `clean -fdx` emptied — the property
 *       every caller of the reset depends on, and the one a reset whose initialisation
 *       sat outside it does not have;
 *   (g) with `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` no reset asks git to populate
 *       anything: a base whose submodule remote is gone does not throw, the recorded
 *       git argvs hold no submodule call, and the gitlink stays an empty directory
 *       exactly as v0.14.71 left it. The control runs the same tree shape with the
 *       switch unset, so the arm is about the switch and not about a remote git could
 *       have fetched anyway.
 *
 * Real temp repos, real git, the real `execp`; nothing stubbed but the model these
 * steps do not use.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import type { ExecFn } from "../src/worktree.ts";
import { resetWorktreeToBase } from "../src/lean/specify-reset.ts";
import { gitTestEnv, trackedTempDir } from "./lib/git-test-env.ts";
import { withEnv } from "./lib/env-scope.ts";

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
  assert(existsSync(path.join(wt, INSIDE)) === true, "(f) the prepared tree has the submodule populated");
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

// ── (g) off: no reset anywhere asks git to populate anything
{
  // The off arm asserts ABSENCE from what the step actually asked git to run — the
  // recorded argv — rather than any submodule OUTCOME: an un-populated submodule is
  // exactly what v0.14.71 handed the child, so "the directory is empty" is the pass
  // condition here and the failure condition in (f).
  const remote = remoteRepo();
  const { repoRoot, baseSha } = repoWithSubmodule(remote);
  // Un-populate the checkout `submodule add` made and remove the source, so the only
  // way to the content is a clone that is about to be impossible.
  const wt = worktreeAt(repoRoot, baseSha, "lean-153");
  rmSync(path.join(wt, SUB), { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
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
    threw === undefined,
    `(g) resetting a tree whose submodule remote is gone does not throw with the switch at 0 (${threw ? `${threw.name}: ${threw.message.split("\n")[0]}` : "clean"})`,
  );
  assert(
    submoduleCalls(argvs).length === 0,
    `(g) and the reset issued no submodule call of any kind (got ${JSON.stringify(submoduleCalls(argvs))})`,
  );
  assert(
    existsSync(path.join(wt, INSIDE)) === false,
    "(g) and the gitlink stayed an empty directory, exactly as v0.14.71 left it",
  );

  // The control, OUTSIDE the `withEnv` above: the same tree shape with the switch
  // unset. Without it (g) could be about a remote git would have fetched anyway.
  const remote2 = remoteRepo();
  const on = repoWithSubmodule(remote2);
  const onWt = worktreeAt(on.repoRoot, on.baseSha, "lean-154");
  const onExec = watcher();
  let onThrew: Error | undefined;
  try {
    await resetWorktreeToBase(onExec.exec, onWt, on.baseSha, "");
  } catch (err) {
    onThrew = err as Error;
  }
  assert(
    onThrew === undefined && submoduleCalls(onExec.argvs).length > 0,
    `(g/ON) the same reset DOES ask git to populate the submodule with the switch on (${onThrew?.message?.split("\n")[0] ?? JSON.stringify(submoduleCalls(onExec.argvs))})`,
  );
  assert(
    existsSync(path.join(onWt, INSIDE)) === true,
    "(g/ON) and it left the submodule populated",
  );
}

process.exit(exit);
