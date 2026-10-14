/**
 * worktree-loss — the #475 no-loss rule for existing worktrees (split from
 * worktree.ts for the AGENTS.md §12 500-line cap).
 *
 * `worktreeCreate` and its sibling scan must not force-remove a worktree that
 * holds work git cannot recover. The rule (#1170):
 *
 *  - A worktree is NO-LOSS only when `git status --porcelain` is empty AND
 *    `HEAD^{tree}` equals `<fromRef>^{tree}`. A commit ahead of the base with
 *    an identical tree (the develop commit the consolidation re-committed under
 *    a new SHA) holds no work that the base does not already contain.
 *  - ANY git error on those reads counts as loss and keeps the refusal. An
 *    unreadable worktree is not evidence that it is clean.
 *  - A path with no directory on disk is not a worktree — nothing to inspect.
 */

import fs from "node:fs/promises";
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
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const raw = String(e?.stderr ?? e?.message ?? err).trim();
  return raw.replace(/^\s*Command failed:\s*.*\n?/s, "").trim() || "unknown git error";
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
  try {
    await execFn(`git rev-parse --verify ${JSON.stringify("HEAD")}`, {
      cwd: worktreeAbs,
      maxBuffer: 64 * 1024,
    });
  } catch (err) {
    // No directory on disk: no live worktree here — nothing to inspect.
    // An existing directory whose HEAD cannot be read is NOT clean (#1170).
    if (!(await pathExists(worktreeAbs))) return undefined;
    return unreadable(err);
  }
  let porcelain: string;
  let headTree: string;
  let baseTree: string;
  let ahead: number;
  try {
    ({ stdout: porcelain } = await execFn("git status --porcelain", {
      cwd: worktreeAbs,
      maxBuffer: 1024 * 1024,
    }));
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
    // The count only labels the finding; the no-loss decision is tree-based.
    ahead = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead < 0) ahead = 0;
  } catch (err) {
    return unreadable(err);
  }
  const files = porcelain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const treeDiffers = headTree.trim() !== baseTree.trim();
  if (files.length === 0 && !treeDiffers) return undefined;
  return {
    path: worktreeAbs,
    uncommittedFiles: files,
    unpushedCommitCount: ahead,
    treeDiffers,
  };
}
