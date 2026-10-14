/**
 * worktree-loss — the #475 no-loss rule for existing worktrees (split from
 * worktree.ts for the AGENTS.md §12 500-line cap).
 *
 * `worktreeCreate` and its sibling scan must not force-remove a worktree that
 * holds work git cannot recover. The rule (#1170):
 *
 *  - A directory is inspected only when it is its OWN worktree root: a
 *    `<abs>/.git` exists and `git rev-parse --show-toplevel` resolves to
 *    `<abs>`. A plain directory inside a repo (git walks up to the parent) is
 *    not a worktree and is never treated as clean.
 *  - Uncommitted work is any `git status --porcelain --ignored
 *    --untracked-files=all` entry, EXCEPT ignored symlinks (provisioned links
 *    such as node_modules) and ignored entries under the regenerable dirs
 *    (node_modules, .venv, vendor, target, dist, build) at any depth.
 *  - With no uncommitted work, the worktree is no-loss when its tree equals
 *    `<fromRef>^{tree}`, OR when HEAD is an ancestor of `<fromRef>` (a worktree
 *    behind the base holds nothing the base lacks). Otherwise HEAD carries
 *    commits the base does not, and that is loss.
 *  - ANY git error on those reads counts as loss and keeps the refusal. An
 *    unreadable worktree is not evidence that it is clean. Trade-off (#1170):
 *    an unreadable leftover now blocks the cycle instead of being removed —
 *    fail closed beats the old wedged-queue avoidance.
 *  - A path with no directory on disk is not a worktree — nothing to inspect.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExecFn } from "./worktree.ts";

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
export class DirtyWorktreeError extends Error {
  /** The absolute worktree path and what it holds — the plumb report and the
   * #545 same-issue salvage use this instead of re-scanning the name. */
  readonly finding: DirtyWorktreeFinding;

  constructor(finding: DirtyWorktreeFinding) {
    super(DirtyWorktreeError.messageFor(finding));
    this.name = "DirtyWorktreeError";
    this.finding = finding;
  }

  static messageFor(finding: DirtyWorktreeFinding): string {
    // If the worktree is being retained, return a retention message.
    if (finding.retained === true) {
      return `refusing to pre-remove retained worktree ${finding.path} — it is in the retained names set`;
    }
    const fromRef =
      finding.unpushedCommitCount > 0 ? ` (unpushed commits: ${finding.unpushedCommitCount})` : "";
    const parts = [
      `refusing to force-remove existing worktree ${finding.path} — it holds unrecoverable work:`,
      finding.notOwnWorktree === true
        ? "(not a worktree of its own — git does not report this directory as its own toplevel)"
        : "",
      finding.uncommittedFiles.length > 0
        ? `${finding.uncommittedFiles.length} uncommitted file(s): ${finding.uncommittedFiles
            .slice(0, 8)
            .join(", ")}${finding.uncommittedFiles.length > 8 ? ", …" : ""}`
        : "",
      fromRef,
      finding.treeDiffers === true && finding.uncommittedFiles.length === 0
        ? "(its tree differs from the base)"
        : "",
      finding.inspectError !== undefined
        ? `(git could not read it — treated as loss: ${finding.inspectError})`
        : "",
    ].filter(Boolean);
    parts.push(
      "Inspect the worktree (`git status`, `git diff`), salvage the work (e.g. `git diff > patch` or commit it to a branch), then remove it (`git worktree remove --force -- <path>`) and re-run.",
    );
    return parts.join(" ");
  }
}

export interface DirtyWorktreeFinding {
  path: string;
  uncommittedFiles: string[];
  unpushedCommitCount: number;
  /** True when the worktree is being retained (not removed) due to being in the retained names set. */
  retained?: boolean;
  /** True when `HEAD^{tree}` differs from `<fromRef>^{tree}`. */
  treeDiffers?: boolean;
  /** Set when a git read failed — the worktree is refused, not assumed clean. */
  inspectError?: string;
  /** True when the directory is not its own worktree root (#1170). */
  notOwnWorktree?: boolean;
}

/** Directories a build regenerates; ignored entries under them are not work. */
const REGENERABLE_DIRS = new Set(["node_modules", ".venv", "vendor", "target", "dist", "build"]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const raw = String(e?.stderr ?? e?.message ?? err).trim();
  return raw.replace(/^\s*Command failed:\s*.*\n?/s, "").trim() || "unknown git error";
}

/**
 * Which porcelain entries are uncommitted work. Tracked and untracked changes
 * always are. An ignored entry is work unless it is a symlink (a provisioned
 * link) or lies under a regenerable directory at any depth.
 */
async function uncommittedEntries(worktreeAbs: string, porcelain: string): Promise<string[]> {
  const out: string[] = [];
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const entry = line.slice(3).replace(/\/$/, "");
    if (status !== "!!") {
      out.push(line.trim());
      continue;
    }
    if (entry.split("/").some((seg) => REGENERABLE_DIRS.has(seg))) continue;
    try {
      if ((await fs.lstat(path.join(worktreeAbs, entry))).isSymbolicLink()) continue;
    } catch {
      // Unstattable ignored entry: cannot prove it is a link — treat as work.
    }
    out.push(line.trim());
  }
  return out;
}

/**
 * Inspect an existing worktree for work a force-remove would destroy.
 *
 * Returns `undefined` only when the worktree is provably no-loss (see the
 * module header). Otherwise returns a finding — including the case where a git
 * read failed, which is reported through `inspectError` rather than thrown.
 */
export async function inspectWorktreeForLoss(
  execFn: ExecFn,
  _repoRoot: string,
  worktreeAbs: string,
  fromRef: string,
): Promise<DirtyWorktreeFinding | undefined> {
  const unreadable = (err: unknown): DirtyWorktreeFinding => ({
    path: worktreeAbs,
    uncommittedFiles: [],
    unpushedCommitCount: 0,
    inspectError: errorText(err),
  });
  // A path with no directory is not a worktree — nothing on disk to inspect.
  if (!(await pathExists(worktreeAbs))) return undefined;
  const notOwn: DirtyWorktreeFinding = {
    path: worktreeAbs,
    uncommittedFiles: [],
    unpushedCommitCount: 0,
    notOwnWorktree: true,
  };
  // A directory on disk must be its OWN worktree root, checked before any other
  // read (#1170). A plain directory under a repo would otherwise resolve git's
  // parent repo and be read as that repo's clean worktree.
  if (!(await pathExists(path.join(worktreeAbs, ".git")))) return notOwn;
  let toplevel: string;
  try {
    ({ stdout: toplevel } = await execFn("git rev-parse --show-toplevel", {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    }));
  } catch (err) {
    return unreadable(err);
  }
  const top = await realpathOrUndefined(toplevel.trim());
  const own = await realpathOrUndefined(worktreeAbs);
  if (top === undefined || own === undefined || top !== own) return notOwn;
  try {
    await execFn(`git rev-parse --verify ${JSON.stringify("HEAD")}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
  } catch (err) {
    return unreadable(err);
  }

  let porcelain: string;
  let headTree: string;
  let baseTree: string;
  let ahead: number;
  try {
    ({ stdout: porcelain } = await execFn(
      "git status --porcelain --ignored --untracked-files=all",
      {
        cwd: worktreeAbs,
        maxBuffer: 8 * 1024 * 1024,
      },
    ));
    ({ stdout: headTree } = await execFn(`git rev-parse ${JSON.stringify("HEAD^{tree}")}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    }));
    // Worktrees share the repo's object database: the base tree resolves the
    // same from inside the worktree as from repoRoot.
    ({ stdout: baseTree } = await execFn(`git rev-parse ${JSON.stringify(`${fromRef}^{tree}`)}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    }));
    const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(`${fromRef}..HEAD`)}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
    // Zero commits HEAD has and fromRef lacks ⟺ HEAD is an ancestor of fromRef.
    ahead = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead < 0) throw new Error(`unreadable commit count: ${stdout}`);
  } catch (err) {
    return unreadable(err);
  }
  const treeDiffers = headTree.trim() !== baseTree.trim();
  const files = await uncommittedEntries(worktreeAbs, porcelain);
  if (files.length > 0) {
    return { path: worktreeAbs, uncommittedFiles: files, unpushedCommitCount: ahead, treeDiffers };
  }
  if (!treeDiffers) return undefined; // tree-identical: nothing the base lacks
  if (ahead === 0) return undefined; // behind the base: nothing unique to HEAD
  return { path: worktreeAbs, uncommittedFiles: [], unpushedCommitCount: ahead, treeDiffers };
}
