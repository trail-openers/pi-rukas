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
import { trace } from "./trace.ts";
import { provisionWorktree } from "./worktree-provision.ts";

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
}

/**
 * A leftover worktree holds work we would otherwise destroy.
 *
 * `worktreeCreate` pre-removes an existing worktree at the same path so a
 * resumed cycle is not wedged by its own leftover — but a `git worktree remove
 * --force` does not check what it is removing. The develop step instructs
 * developers not to commit, so a cycle that died mid-develop leaves its diff
 * uncommitted in the worktree: not in the object database, unrecoverable
 * (#475). The force-remove destroyed it with no warning, and deleting
 * unrecoverable work must never be the silent default.
 */
export class DirtyWorktreeError extends Error {}

export interface DirtyWorktreeFinding {
  path: string;
  uncommittedFiles: string[];
  unpushedCommitCount: number;
}

/**
 * Inspect an existing worktree for work a force-remove would destroy.
 *
 * Two signals: uncommitted files (`git status --porcelain` in the worktree)
 * and local commits ahead of `fromRef` (`rev-list --count` — a worktree that
 * committed past its base, e.g. cherry-pick integration, would lose those).
 * The check itself must never fail the create: an unreadable worktree is
 * removed as today, because refusing on a git error would reintroduce the
 * wedged-queue leftover class the pre-remove exists to prevent.
 */
export async function inspectWorktreeForLoss(
  execFn: ExecFn,
  repoRoot: string,
  worktreeAbs: string,
  fromRef: string,
): Promise<DirtyWorktreeFinding | undefined> {
  let exists = false;
  try {
    await execFn(`git rev-parse --verify ${JSON.stringify("HEAD")}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
    exists = true;
  } catch {
    return undefined; // no live worktree here — nothing to inspect
  }
  if (!exists) return undefined;
  let porcelain = "";
  try {
    ({ stdout: porcelain } = await execFn("git status --porcelain", {
      cwd: worktreeAbs,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    porcelain = "";
  }
  let ahead = 0;
  try {
    const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(`${fromRef}..HEAD`)}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
    ahead = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead < 0) ahead = 0;
  } catch {
    ahead = 0;
  }
  const files = porcelain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (files.length === 0 && ahead === 0) return undefined;
  return { path: worktreeAbs, uncommittedFiles: files, unpushedCommitCount: ahead };
}

/**
 * Create a worktree, returning its absolute path.
 *
 * Idempotent by construction: an existing worktree at the same path is removed
 * first. A resumed cycle must not fail because its own previous attempt left a
 * directory behind — that is the class of leftover that wedged whole queues.
 *
 * The pre-remove is guarded (#475): when the leftover holds uncommitted work
 * or local commits, force-removing it would destroy work that is nowhere else
 * (develop diffs are never committed). `worktreeCreate` then throws a
 * `DirtyWorktreeError` naming the absolute path instead, and the caller
 * (`mechanizedBranchSetup`) refuses — no fallback, because the LLM ops path
 * would destroy the same work through the same `--force` — routing the cycle
 * to handoff. A clean leftover is removed as before.
 */
export async function worktreeCreate(execFn: ExecFn, opts: WorktreeCreateOpts): Promise<string> {
  const abs = worktreePath(opts.repoRoot, opts.name);
  const leftover = await inspectWorktreeForLoss(execFn, opts.repoRoot, abs, opts.fromRef);
  if (leftover) {
    const parts = [
      `refusing to force-remove existing worktree ${leftover.path} — it holds unrecoverable work:`,
      leftover.uncommittedFiles.length > 0
        ? `${leftover.uncommittedFiles.length} uncommitted file(s): ${leftover.uncommittedFiles
            .slice(0, 8)
            .join(", ")}${leftover.uncommittedFiles.length > 8 ? ", …" : ""}`
        : "",
      leftover.unpushedCommitCount > 0
        ? `${leftover.unpushedCommitCount} local commit(s) ahead of ${opts.fromRef}`
        : "",
    ].filter(Boolean);
    parts.push(
      "Inspect the worktree (`git status`, `git diff`), salvage the work (e.g. `git diff > patch` or commit it to a branch), then remove it (`git worktree remove --force -- <path>`) and re-run.",
    );
    throw new DirtyWorktreeError(parts.join(" "));
  }
  await worktreeRemove(execFn, opts.repoRoot, opts.name, true).catch(() => undefined);
  // Always detached at baseSha: a named branch in a worktree contradicts
  // #287 (worktrees are the workstream's scratch space; the feature branch
  // only ever exists at repoRoot, where integration happens) and breaks the
  // invariant test-work-driver-always-worktree.ts enforces.
  await execFn(`git worktree add --detach ${JSON.stringify(abs)} ${JSON.stringify(opts.fromRef)}`, {
    cwd: opts.repoRoot,
    maxBuffer: 1024 * 1024,
  });
  // A worktree with only tracked files cannot run the project's own commands:
  // every gitignored dependency directory is absent, and the develop step runs
  // the verify command in here. Never throws — a bare worktree is what shipped
  // before this, so a provisioning failure is the status quo, not a regression.
  const provisioned = await provisionWorktree(execFn, opts.repoRoot, abs);
  if (provisioned.problem) {
    trace(`worktree: ${opts.name} provisioning incomplete — ${provisioned.problem}`);
  }
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
