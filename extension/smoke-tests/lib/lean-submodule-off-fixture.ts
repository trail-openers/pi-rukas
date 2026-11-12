/**
 * lib/lean-submodule-off-fixture — the shared plumbing for #2212's three
 * per-path submodule-off files (`test-lean-challenge-submodule-off.ts`,
 * `test-lean-build-submodule-off.ts`, `test-lean-review-submodule-off.ts`).
 *
 * R1 puts the switch inside `resetWorktreeToBase`, so one gate covers every
 * caller. These files exist because R1 also asks for a case at each caller
 * OUTSIDE specify: a reader of the reset alone cannot see that `build`'s fold and
 * the review fix round reach it at all, and a per-caller gate — the shape #2212
 * replaces — would look identical from the outside if one caller were moved back
 * outside it. So each file drives its own step over a base whose submodule source
 * is GONE, reads the git argv the step itself issued, and asserts both halves: no
 * submodule call, and no throw.
 *
 * The source is deleted rather than the tree merely emptied, because that is what
 * makes the call FAIL: with no cached object and no reachable remote, git cannot
 * populate the gitlink, so a step that issued the command hands its run back and
 * a step that did not is the switch working. Silence is then evidence, not luck.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitTestEnv, trackedTempDir } from "./git-test-env.ts";

/** The submodule's mount point and the file committed inside it. */
export const SUB = "vendor/lib";
export const INSIDE = `${SUB}/lib`;

/**
 * git in `dir` under the isolated test env, with a commit identity supplied
 * per-call rather than inherited: these fixtures commit from trees that were
 * `init`ed minutes earlier and carry no `user.email`, and the repo fixtures this
 * file attaches to do the same (`-c user.email=…` on every commit) so a host
 * config can never decide what a fixture's history looks like.
 */
export function gitIn(dir: string, ...args: string[]): string {
  const id = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  const r = spawnSync("git", [...id, ...args], { cwd: dir, encoding: "utf8", env: gitTestEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** Write `text` at `rel` under `dir`, making the parents. */
export function putIn(dir: string, rel: string, text: string, mode?: number): void {
  const target = path.join(dir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, mode === undefined ? undefined : { mode });
}

/**
 * The submodule add's own flags, passed with `-c` rather than through the env.
 *
 * A fixture's ambient env carries no identity or protocol policy — the repo
 * fixtures in this directory all commit with `-c user.email=…` — so a
 * `GIT_CONFIG_*` pair added to `process.env` would be a second, invisible way to
 * configure the same run, and `protocol.file.allow` is `denied by default` since
 * git's CVE-2022-39253 hardening, so it must be stated where git can see it.
 */
export const SUBMODULE_ADD_FLAGS = [
  "-c",
  "protocol.file.allow=always",
] as const;

/**
 * A standalone repo to mount as a submodule, with one committed file.
 *
 * It lives OUTSIDE the repo that mounts it and gets deleted by
 * `makeSubmoduleUnfetchable`, which is what makes a submodule call fail rather
 * than succeed quietly from cache.
 */
export function remoteRepo(tag: string): string {
  const remote = trackedTempDir(`${tag}-remote-`);
  gitIn(remote, "init", "-q", "-b", "main");
  putIn(remote, "lib", "the submodule's own content\n");
  gitIn(remote, "add", "-A");
  gitIn(remote, "commit", "-q", "-m", "the submodule's content");
  return remote;
}

/**
 * Attach `remote` as a submodule at `vendor/lib` in a repo that already exists,
 * on the branch that tree holds, and commit the gitlink there. Pass the tree
 * whose branch should carry the gitlink — for a run whose fold resets to the run
 * head, that is the run's worktree, not the superproject's checkout.
 *
 * A separate step from `remoteRepo` because the step fixtures
 * (`challengeFixture`, `buildFixture`, the review fixture) each build their own
 * repo with their own git wrapper and identity: the gitlink has to be added to a
 * tree that already exists, on the branch that tree holds, so the fixture stays
 * the only thing that knows how its repo was made.
 */
export function attachSubmodule(
  tree: string,
  remote: string,
  message = "add the vendored submodule",
): string {
  gitIn(tree, ...SUBMODULE_ADD_FLAGS, "submodule", "add", "-q", "--force", remote, SUB);
  gitIn(tree, "commit", "-q", "-m", message);
  return gitIn(tree, "rev-parse", "HEAD");
}

/**
 * Make the submodule unrecoverable by any `submodule update --init --recursive`,
 * which is what makes the step's call FAIL rather than quietly succeed.
 *
 * Three deletions, each doing a job the others cannot. Measured on this host, all
 * three are needed for git to exit non-zero with `repository … does not exist`:
 *
 *  - empty the checkout under `tree/vendor/lib`, because that is what gives the
 *    reset something to restore — a checkout that still held its file would make a
 *    switch-off run indistinguishable from a switch-on one, since the child would
 *    see the content either way;
 *  - delete the SOURCE repo, so there is nothing to clone from;
 *  - delete the submodule's object store, wherever git put it. A module added from
 *    inside a linked worktree keeps its objects under the superrepo's
 *    `.git/worktrees/<tree>/modules/<path>` and its checkout's `.git` is a pointer
 *    file naming that directory; `submodule update` completes from those objects
 *    and the deleted remote is never contacted, so the store — not just the
 *    checkout, and not just the remote — has to be gone. Probing one candidate name
 *    and assuming it is the only one is how a control ends up green for the wrong
 *    reason, so every gitdir this tree can name is tried.
 *
 * The gitlink itself stays: it is what the reset reads to decide the tree has
 * submodules at all, and deleting it would test a step that had nothing to do.
 */
export function makeSubmoduleUnfetchable(remote: string, tree: string): void {
  rmSync(path.join(tree, SUB), { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
  for (const dir of moduleStores(tree)) {
    for (const cand of [dir, path.join(dir, "modules")]) {
      try {
        rmSync(path.join(cand, ...SUB.split("/")), { recursive: true, force: true });
      } catch {
        /* not a store (the name is a file, or absent) — the next candidate may be */
      }
    }
  }
}

/**
 * Every directory that could hold `tree`'s submodule object store.
 *
 * `--git-common-dir` names the superrepo for a plain checkout and the per-worktree
 * gitdir for a linked one, and `--git-dir` can name a third; a linked tree's `.git`
 * POINTER FILE names the gitdir whose `modules/` actually holds the objects, which
 * is the case the two `rev-parse` answers do not surface as something a caller can
 * join. All of them are tried, because guessing wrong here does not fail loudly —
 * it silently makes a control pass.
 */
function moduleStores(tree: string): string[] {
  const dirs = new Set<string>();
  for (const arg of ["--git-common-dir", "--git-dir", "--absolute-git-dir"]) {
    const r = spawnSync("git", ["rev-parse", arg], {
      cwd: tree,
      encoding: "utf8",
      env: gitTestEnv(),
    });
    const dir = (r.stdout ?? "").trim();
    if (r.status === 0 && dir !== "") dirs.add(path.resolve(tree, dir));
  }
  const pointer = readFileOrNull(path.join(tree, ".git"));
  const gitdir = pointer?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (gitdir !== undefined) dirs.add(path.resolve(tree, gitdir));
  return [...dirs];
}

function readFileOrNull(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Every recorded git call that asks git anything about submodules. */
export function submoduleCalls(
  argvs: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  return argvs.filter((argv) => argv.includes("submodule") || argv.includes(".gitmodules"));
}
