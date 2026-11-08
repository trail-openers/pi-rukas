#!/usr/bin/env bun
/**
 * lean reset — `resetWorktreeToBase` walks a tree that is one commit ahead AND
 * dirty all the way back to the base, for both the branch and the detached form.
 *
 * The field shape (#2113): a build child commits its file and then keeps editing
 * that same file; its turn ends with the edit uncommitted. The fold's first
 * mutation is the reset, and a plain `git checkout -B <branch> <base>` refuses
 * outright — "Your local changes to the following files would be overwritten by
 * checkout", exit 1 — because the edit sits on a path the move would have to
 * rewrite. The `reset --hard` that would have discarded it never runs, so the
 * whole function throws and a routine budget stop hands the run back.
 *
 * Three dirt forms are planted at once, because each is a separate refusal in
 * git and a fix that clears one can leave another in the index: an unstaged edit
 * to a path the child's own commit changed, a STAGED rename, and untracked files.
 * The assertions are the ones the function's own contract promises — `rev-parse
 * HEAD` equals the base and `status --porcelain -uall` reports nothing.
 *
 * Real temp repos, real git, the real `execp`; nothing stubbed.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import type { ExecFn } from "../src/worktree.ts";
import { resetWorktreeToBase } from "../src/lean/specify-reset.ts";
import { gitTestEnv, trackedTempDir } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const env = {
  ...gitTestEnv(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
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

/**
 * A repo at `base`, one child commit above it, and a worktree at that commit
 * carrying the whole dirt field. `detached` leaves the tree on no branch, which
 * is the shape a caller passes `""` for.
 */
function dirtyTree(issue: number, detached: boolean): { wt: string; base: string; branch: string } {
  const root = trackedTempDir("lean-reset-");
  git(root, "init", "-q", "-b", "main");
  put(root, "src/retry.ts", "one\n");
  put(root, "src/keep.ts", "keep\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  const branch = `lean/issue-${issue}`;
  // The child's own commit: it changed `src/retry.ts`.
  put(root, "src/retry.ts", "two\n");
  git(root, "add", "-A", "src/retry.ts");
  git(root, "commit", "-q", "-m", "child: first cut");
  const head = git(root, "rev-parse", "HEAD");
  // Back on `main` first, so the worktree alone holds the branch the reset moves.
  git(root, "checkout", "-q", "main");
  const wt = path.join(root, ".worktrees", `lean-${issue}`);
  git(root, "worktree", "add", "-q", ...(detached ? ["--detach"] : ["--checkout", "-B", branch]), wt, head);
  // (a) the unstaged edit to the path the child commit changed — the refusal.
  put(wt, "src/retry.ts", "three\n");
  // (b) a staged delete-and-add — what `git add -A` of a rename puts in the child's
  // index, in the form git itself reports it.
  rmSync(path.join(wt, "src/keep.ts"));
  put(wt, "src/kept.ts", "keep edited\n");
  git(wt, "add", "-A", "src/keep.ts", "src/kept.ts");
  // (c) untracked dirt the clean has to take.
  put(wt, "notes/build-notes.txt", "scratch\n");
  return { wt, base, branch };
}

for (const detached of [false, true]) {
  const form = detached ? "detached" : "branch";
  const { wt, base, branch } = dirtyTree(detached ? 5202 : 5201, detached);
  const porcelain = git(wt, "status", "--porcelain", "-uall");
  assert(
    git(wt, "rev-list", "--count", `${base}..HEAD`) === "1" &&
      porcelain.includes(" M src/retry.ts") &&
      porcelain.includes("D  src/keep.ts") &&
      porcelain.includes("A  src/kept.ts") &&
      porcelain.includes("?? notes/build-notes.txt"),
    `(${form}) the fixture starts one commit ahead with an unstaged edit, a staged rename and untracked dirt (got ${JSON.stringify(porcelain)})`,
  );
  let threw: Error | undefined;
  try {
    await resetWorktreeToBase(execp as ExecFn, wt, base, detached ? "" : branch);
  } catch (err) {
    threw = err as Error;
  }
  let head = "";
  let dirty = "<unreadable>";
  try {
    head = git(wt, "rev-parse", "HEAD");
    dirty = git(wt, "status", "--porcelain", "-uall");
  } catch {
    /* the tree is gone; the assertions below read as failures */
  }
  assert(
    threw === undefined,
    `(${form}) the reset of a dirty tree does not throw (got ${threw ? `${threw.name}: ${threw.message.split("\n")[0]}` : "clean"})`,
  );
  assert(
    threw === undefined && head === base,
    `(${form}) HEAD is the base ${base.slice(0, 8)} after the reset (got ${head.slice(0, 8) || "unreadable"})`,
  );
  assert(
    threw === undefined && dirty === "",
    `(${form}) the status is clean after the reset (got ${JSON.stringify(dirty)})`,
  );
  if (!detached)
    assert(
      threw === undefined && git(wt, "symbolic-ref", "--short", "HEAD") === branch,
      `(${form}) the tree sits on the run's branch, not a detached HEAD (got ${threw ? "n/a" : git(wt, "symbolic-ref", "--short", "HEAD")})`,
    );
}

process.exit(exit);
