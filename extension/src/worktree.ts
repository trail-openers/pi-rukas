/**
 * worktree — git worktree helpers for the always-worktree driver (#287).
 *
 * Rewritten from the P1 stub, which had no importers: it shelled out with
 * `execFile` in `process.cwd()`, always created a `scratch/<name>` branch, and
 * returned a relative path. All three are wrong for the driver, which operates
 * on an absolute repoRoot, wants worktrees DETACHED at a base SHA (a scratch
 * branch per workstream is a second thing to clean up and a second way to
 * confuse `git rev-parse --abbrev-ref HEAD`), and needs absolute paths to hand
 * to subagents as their cwd.
 *
 * Every call takes the driver's `ExecFn` so the same injection seam the verify
 * gates use covers worktree setup too — #287's acceptance criterion is a test
 * that records (command, cwd) pairs and asserts no git command runs with
 * `cwd === repoRoot` between branch and commit-pr, which is only observable if
 * these calls go through that seam.
 */

import path from "node:path";

/** Shell executor, matching `DriverContext.verifyExecFn`. */
export type ExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
) => Promise<{ stdout: string; stderr?: string }>;

/** Worktrees live under `<repoRoot>/.worktrees/<name>`. */
export function worktreePath(repoRoot: string, name: string): string {
  return path.join(repoRoot, ".worktrees", name);
}

export interface WorktreeCreateOpts {
  repoRoot: string;
  /** Directory name under `.worktrees/`, e.g. `issue-287-default`. */
  name: string;
  /** Commit-ish the worktree starts at — the driver passes the resolved baseSha. */
  fromRef: string;
  /**
   * Create and check out this branch instead of detaching. The driver leaves
   * this unset: development happens on a detached HEAD and the feature branch
   * only ever exists at repoRoot, where integration happens.
   */
  branch?: string;
}

/**
 * Create a worktree, returning its absolute path.
 *
 * Idempotent by construction: an existing worktree at the same path is removed
 * first. A resumed cycle must not fail because its own previous attempt left a
 * directory behind — that is the class of leftover that wedged whole queues.
 */
export async function worktreeCreate(execFn: ExecFn, opts: WorktreeCreateOpts): Promise<string> {
  const abs = worktreePath(opts.repoRoot, opts.name);
  await worktreeRemove(execFn, opts.repoRoot, opts.name, true).catch(() => undefined);
  const target = opts.branch
    ? `-B ${JSON.stringify(opts.branch)} ${JSON.stringify(abs)} ${JSON.stringify(opts.fromRef)}`
    : `--detach ${JSON.stringify(abs)} ${JSON.stringify(opts.fromRef)}`;
  await execFn(`git worktree add ${target}`, {
    cwd: opts.repoRoot,
    maxBuffer: 1024 * 1024,
  });
  return abs;
}

export async function worktreeRemove(
  execFn: ExecFn,
  repoRoot: string,
  name: string,
  force = false,
): Promise<void> {
  const abs = worktreePath(repoRoot, name);
  await execFn(`git worktree remove ${force ? "--force " : ""}${JSON.stringify(abs)}`, {
    cwd: repoRoot,
    maxBuffer: 256 * 1024,
  });
}

/** Drop administrative records for worktrees whose directories are gone. */
export async function worktreePrune(execFn: ExecFn, repoRoot: string): Promise<void> {
  await execFn("git worktree prune", { cwd: repoRoot, maxBuffer: 256 * 1024 });
}

export async function worktreeList(execFn: ExecFn, repoRoot: string): Promise<string> {
  const { stdout } = await execFn("git worktree list --porcelain", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}
