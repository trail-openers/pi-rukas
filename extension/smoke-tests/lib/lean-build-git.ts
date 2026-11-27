/**
 * smoke-tests/lib/lean-build-git — the git identity, the git runner, and the bytes a fixture child
 * leaves in a tree. Split from `lean-build-fixture.ts` (AGENTS.md §12): the fixture builds a repo
 * and drives the step; this is the small contract its git children need — an identity in the
 * child's own environment, so a commit inside a case is attributed and never reaches a real config —
 * and the writers that put bytes where a git child can see them.
 *
 * It depends on NOTHING else in the fixture family: `lean-build-artifacts.ts` and
 * `lean-build-asserts.ts` both import the runner from here, so the git contract sits at the bottom
 * of the dependency order rather than circling back through the fixture.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

/** The identity every git child runs with, the production commit included. */
export function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/** The same identity, for the challenge fixture's own git children. */
export function gitEnvFor(): Record<string, string> {
  return gitEnv();
}

/** git in `dir`, with an identity in the child's environment. */
export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** Worktree-relative path of a file the child may create. */
export function put(wt: string, rel: string, content: string, mode?: number): void {
  const target = path.join(wt, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: mode ?? 0o644 });
}

/** The child made a symlink at `rel` pointing at `target`. */
export function symlink(wt: string, rel: string, target: string): void {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  symlinkSync(target, path.join(wt, rel));
}

/**
 * The child hard-linked `rel` in the worktree to a file OUTSIDE the repo.
 * `linkSync` across filesystems throws EXDEV, so the outside file is written
 * into the same filesystem as the repo.
 */
export function hardlinkFromOutside(wt: string, rel: string, outsideAbs: string): void {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  linkSync(outsideAbs, path.join(wt, rel));
}

/**
 * Write a file outside every repo and return its absolute path, so a link case
 * can point at it. The return is the whole point: a caller that had to rebuild
 * the path would be asserting against a string it invented rather than the file
 * it wrote.
 */
export function putOutside(abs: string, content: string): string {
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/**
 * One file committed into a FIXTURE commit, executable, with its parent
 * directories — the shape an acceptance test needs so the project's runner can
 * run it. `dir` is the caller's repo-relative joiner, so a fixture never spells
 * an absolute path and a case never chooses a mode: these are committed bytes.
 */
export function putCommitted(dir: (rel: string) => string, rel: string, text: string): void {
  const target = dir(rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, { mode: 0o755 });
  chmodSync(target, 0o755);
}

/** The child committed whatever it had, itself. */
export function childCommit(wt: string, message: string): void {
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", message);
}

/** The worktree's HEAD, or `""` when the tree is gone. */
export function headOf(wt: string): string {
  try {
    return git(wt, "rev-parse", "HEAD");
  } catch {
    return "";
  }
}
