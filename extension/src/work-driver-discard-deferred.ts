/**
 * work-driver-discard-deferred — the #1676 discard pass, its own develop-step
 * module (extracted from work-driver-verify-develop-protected.ts).
 *
 * What it does: the plan fences a deferred protected path out of every
 * workstream (`withDeferredProtectedFence`), so an edit to it is a developer
 * ignoring the fence. Rather than halting the cycle after the whole develop
 * spend, each worktree's edit to such a path is reverted to base content (or
 * removed when absent at base), with a revert commit when the edit had been
 * committed. The develop step calls `discardDeferred` explicitly BEFORE its
 * verify loop reads status and diff, so a reverted path never reaches the
 * uncommitted-only, scope or protected-path checks. Any other ungranted
 * protected path still halts in `runProtectedPathGate`.
 *
 * Refusals (each named as a failure, before any mutation of that path):
 *  - no valid base for a worktree (the cycle halts; nothing is skipped silently);
 *  - a path that is itself a symlink, sits under a symlinked directory, is
 *    directory-shaped, or is paired with another path by a rename (committed or
 *    staged);
 *  - a name that differs only in case from the path in the same worktree. Git's
 *    pathspec matching follows core.ignorecase, so every removal and restore is
 *    gated on an EXACT-case match in base, the index or the status entries;
 *  - an unreadable change set. Every read is fail-closed and named: the
 *    committed rename side is `readCommittedProtectedPaths` and the uncommitted
 *    side `worktreeStatus` / `parseStatus` (work-develop-git.ts). A malformed or
 *    failed stream is a failure — never "there was no edit", which is the silent
 *    pass this pass exists to remove.
 *
 * Recovery: `discardOne` captures the path's presence at HEAD BEFORE its first
 * mutation, because asking after a failed `rm` cannot answer it. From that point
 * any failure — a write that throws, a revert commit that does not land —
 * restores the path to HEAD (or removes it when HEAD has no such path) before the
 * failure is reported, so the branch is left as the developer had it.
 * `hooksPath=/dev/null` (work-driver-discard-argv.ts) means a worktree-written
 * hook is not the failure this recovery is for; identity, a read-only object
 * store and a corrupt index are.
 *
 * Import chain: work-driver-verify-develop.ts → this file → work-develop-git.ts +
 * work-driver-discard-argv.ts + work-driver-protected-grant.ts (acyclic). Only the
 * operator's grant is honoured (`grant`), never the state file (#1090).
 */

import { lstat, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS } from "./git-range.ts";
import {
  type ExecFn,
  type StatusEntry,
  errText,
  isValidBaseSha,
  runGit,
  worktreeStatus,
} from "./work-develop-git.ts";
import {
  DISCARD_GIT_ARGV,
  DISCARD_NAME_MAX_BUFFER,
  DISCARD_WRITE_MAX_BUFFER,
} from "./work-driver-discard-argv.ts";
import { ungrantedProtectedPaths } from "./work-driver-protected-grant.ts";
import { readCommittedProtectedPaths } from "./work-driver-protected-paths-read.ts";

export interface DiscardDeferredOptions {
  execFn: ExecFn;
  /** The plan's deferred protected paths (`pipelineState.deferredProtected`). */
  deferred: readonly string[];
  /** The operator's per-cycle `--allow-protected` grant (`ctx.protectedGrant`). */
  grant: readonly string[] | undefined;
  /** The effective base commit of a workstream, as the develop loop resolves it. */
  baseFor: (id: string) => string | undefined;
  /** Workstream id → worktree path. */
  worktrees: Record<string, string>;
}

export interface DiscardDeferredResult {
  notes: string[];
  failures: string[];
  /** Count of (worktree, path) edits reverted. */
  discarded: number;
  discardedPaths: string[];
  /** Workstream ids whose net diff against base is empty after the discard. */
  emptied: Set<string>;
  /** The failure to report when the discard left nothing to ship. */
  onlyFailure: string;
}

type Git = ReturnType<typeof runGit>;

/** Revert every ungranted deferred path in every worktree. See the module jsdoc. */
export async function discardDeferred(o: DiscardDeferredOptions): Promise<DiscardDeferredResult> {
  const out: DiscardDeferredResult = {
    notes: [],
    failures: [],
    discarded: 0,
    discardedPaths: [],
    emptied: new Set(),
    onlyFailure: "",
  };
  const ungranted = ungrantedProtectedPaths([...o.deferred], o.grant);
  if (ungranted.length === 0) return out;
  const git = runGit(o.execFn);
  for (const [id, cwd] of Object.entries(o.worktrees)) {
    const base = o.baseFor(id);
    if (!isValidBaseSha(base)) {
      out.failures.push(
        `cannot discard the edits to deferred protected path(s) ${ungranted.map((p) => `"${p}"`).join(", ")} in worktree "${id}" (${cwd}): no valid base commit to compare against`,
      );
      continue;
    }
    let touched = 0;
    for (const p of ungranted) {
      try {
        if (await discardOne(git, o.execFn, cwd, base, p)) {
          touched++;
          out.discardedPaths.push(p);
          out.notes.push(
            `discarded an edit to deferred protected path "${p}" in workstream "${id}" — the plan fenced it out and it needs an operator grant (--allow-protected) to ship`,
          );
        }
      } catch (err) {
        out.failures.push(
          `could not discard the edit to deferred protected path "${p}" in worktree "${id}" (${cwd}): ${errText(err)}`,
        );
      }
    }
    out.discarded += touched;
    if (touched > 0 && (await netDiffEmpty(git, cwd, base, id, out.failures))) {
      out.emptied.add(id);
    }
  }
  out.discardedPaths = [...new Set(out.discardedPaths)];
  out.onlyFailure = onlyDiscardedFailure(out.discardedPaths);
  return out;
}

/** The failure for a cycle whose only edits were discarded: nothing left to ship. */
function onlyDiscardedFailure(paths: string[]): string {
  const named = paths.map((p) => `"${p}"`).join(", ");
  return `the only edits were to deferred protected path(s) ${named}, which the plan fenced out and were discarded \u2014 nothing else changed. Re-run with --allow-protected <path> to land them`;
}

/**
 * True when the branch's net change against base is empty, judged on the
 * committed diff and the TRACKED changes. Unrelated untracked files are not part
 * of the branch and must not keep an emptied worktree alive. A failed read is a
 * failure, never an empty diff.
 */
async function netDiffEmpty(
  git: Git,
  cwd: string,
  base: string,
  id: string,
  failures: string[],
): Promise<boolean> {
  try {
    const diff = (
      await git(["diff", "--name-only", base, "HEAD"], {
        cwd,
        maxBuffer: DISCARD_NAME_MAX_BUFFER,
        timeout: DEFAULT_GIT_TIMEOUT_MS,
      })
    ).stdout.trim();
    const tracked = (
      await git([...DISCARD_GIT_ARGV, "status", "--porcelain", "--untracked-files=no"], {
        cwd,
        maxBuffer: DISCARD_NAME_MAX_BUFFER,
        timeout: DEFAULT_GIT_TIMEOUT_MS,
      })
    ).stdout.trim();
    return diff.length === 0 && tracked.length === 0;
  } catch (err) {
    failures.push(
      `could not read the net diff of worktree "${id}" after the discard: ${errText(err)}`,
    );
    return false;
  }
}

/** NUL-separated git output as its non-empty entries. */
function nul(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

/** The worktree's uncommitted entries via the shared `-z` reader, or a named failure. */
async function statusEntries(git: Git, cwd: string): Promise<StatusEntry[]> {
  const status = await worktreeStatus(git, cwd);
  if (!Array.isArray(status)) {
    throw new Error(`status read failed: ${status.unreadable}`);
  }
  return status;
}

/**
 * The other side of a committed or staged rename that involves `p`, if any. A
 * rename cannot be discarded one side at a time: reverting only the deferred side
 * would leave its content under the unprotected name (or delete the source), so
 * the caller fails the discard instead.
 *
 * Both sides come from the readers the protected gate already trusts, so a
 * malformed stream is a named failure rather than "no rename" — the committed side
 * is `readCommittedProtectedPaths` (`diff -z --name-status -M -C`, whose typed
 * `NameStatus` records carry `from`/`to`), and the staged side is `parseStatus`
 * over `status --porcelain -z`, whose rename entries carry `pairedWith`. The two
 * layouts put the two sides in OPPOSITE order, which is exactly what a single
 * hand-rolled parser got wrong; there is no hand-rolled parser here.
 */
async function renamePartnerOf(
  git: Git,
  execFn: ExecFn,
  cwd: string,
  base: string,
  p: string,
): Promise<string | undefined> {
  const committed = await readCommittedProtectedPaths(execFn, cwd, base);
  if (!committed.ok) {
    throw new Error(`committed rename read failed: ${committed.unreadable}`);
  }
  for (const r of committed.targets) {
    if (r.kind !== "R" && r.kind !== "C") continue;
    if (r.from === p) return r.to;
    if (r.to === p) return r.from;
  }
  for (const e of await statusEntries(git, cwd)) {
    if (e.pairedWith === undefined) continue;
    if (e.path === p) return e.pairedWith;
    if (e.pairedWith === p) return e.path;
  }
  return undefined;
}

/**
 * `rm` follows a symlinked leading directory, so a deferred path under a symlink
 * could delete outside the worktree; and `git checkout <base> -- p` writes
 * THROUGH a symlinked leaf, replacing the file behind it. Refused before anything
 * is touched — the leaf and each ancestor.
 */
async function refuseSymlink(cwd: string, p: string): Promise<void> {
  const parts = p.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i);
    try {
      if ((await lstat(join(cwd, ...rel))).isSymbolicLink()) {
        throw new Error(
          `refusing to discard "${p}": ${i === parts.length ? "itself" : "its parent"} "${rel.join("/")}" is a symlink`,
        );
      }
    } catch (err) {
      // A missing link is no link; anything else (EACCES, ELOOP) is a refusal.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
}

/**
 * A deferred path is a file. A directory on either side (a tree at base, or a
 * directory in the worktree holding new files) would be restored or removed only
 * in part, leaving the rest behind, so it is refused before anything moves.
 */
async function refuseDirectory(git: Git, cwd: string, base: string, p: string): Promise<void> {
  const baseEntry = (
    await git([...DISCARD_GIT_ARGV, "ls-tree", base, "--", p], {
      cwd,
      maxBuffer: DISCARD_NAME_MAX_BUFFER,
      timeout: DEFAULT_GIT_TIMEOUT_MS,
    })
  ).stdout;
  let isDir = baseEntry.startsWith("040000 ");
  try {
    isDir = isDir || (await lstat(join(cwd, p))).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (isDir) {
    throw new Error(
      `refusing to discard "${p}": it is a directory, and only file paths can be discarded`,
    );
  }
}

/**
 * Whether HEAD carries `p`. Read with `cat-file -e`, git's own existence probe —
 * an exit code, so no content is read and no blob is materialised.
 */
async function existsAtHead(git: Git, cwd: string, p: string): Promise<boolean> {
  try {
    await git([...DISCARD_GIT_ARGV, "cat-file", "-e", `HEAD:${p}`], {
      cwd,
      maxBuffer: DISCARD_WRITE_MAX_BUFFER,
      timeout: DEFAULT_GIT_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    // `cat-file -e` exits 1 for "not here" (git's `InStream` miss) — the
    // documented, expected answer for a file HEAD does not have. Anything else
    // (a broken object store, a bad ref) is an error we must not read as absent:
    // "absent" would make the rollback delete the developer's file.
    if (/fatal:|not a valid object|not a git repository/i.test(errText(err))) {
      throw new Error(`could not determine whether "${p}" exists at HEAD: ${errText(err)}`);
    }
    return false;
  }
}

/**
 * Put the deferred path back to HEAD: content when HEAD has it, removal when it
 * does not. Used by the rollback after ANY failed mutation, so a reported failure
 * never leaves the worktree holding a half-applied discard.
 */
async function restoreToHead(git: Git, cwd: string, p: string, atHead: boolean): Promise<void> {
  if (atHead) {
    await git([...DISCARD_GIT_ARGV, "--literal-pathspecs", "checkout", "HEAD", "--", p], {
      cwd,
      maxBuffer: DISCARD_WRITE_MAX_BUFFER,
      timeout: DEFAULT_GIT_TIMEOUT_MS,
    });
    return;
  }
  await git(
    [
      ...DISCARD_GIT_ARGV,
      "--literal-pathspecs",
      "rm",
      "-r",
      "-f",
      "--ignore-unmatch",
      "-q",
      "--",
      p,
    ],
    { cwd, maxBuffer: DISCARD_WRITE_MAX_BUFFER, timeout: DEFAULT_GIT_TIMEOUT_MS },
  );
  await rm(join(cwd, p), { force: true, recursive: true });
}

/**
 * Commit the revert of `p`. A commit that does not land is restored to HEAD
 * before the failure surfaces, so the index and worktree match the branch as the
 * developer left it. `hooksPath=/dev/null` means a child-written hook is not the
 * expected failure; identity, a read-only object store and a corrupt index are.
 */
async function revertCommit(git: Git, cwd: string, p: string, atHead: boolean): Promise<void> {
  try {
    await git(
      [
        ...DISCARD_GIT_ARGV,
        "--literal-pathspecs",
        "commit",
        "-m",
        `fix(work): discard edit to deferred protected path ${p}`,
        "--",
        p,
      ],
      { cwd, maxBuffer: DISCARD_WRITE_MAX_BUFFER, timeout: DEFAULT_GIT_TIMEOUT_MS },
    );
  } catch (err) {
    try {
      await restoreToHead(git, cwd, p, atHead);
    } catch (restoreErr) {
      throw new Error(
        `the revert commit for "${p}" failed (${errText(err)}) and restoring it to HEAD also failed (${errText(restoreErr)})`,
      );
    }
    throw new Error(
      `the revert commit for "${p}" failed, and the path was restored to HEAD (${errText(err)})`,
    );
  }
}

/** Revert one deferred path in one worktree. Returns true when it was edited. */
async function discardOne(
  git: Git,
  execFn: ExecFn,
  cwd: string,
  base: string,
  p: string,
): Promise<boolean> {
  if (isAbsolute(p) || p.split("/").includes("..")) {
    throw new Error(`refusing to restore an unsafe path "${p}"`);
  }
  await refuseSymlink(cwd, p);
  await refuseDirectory(git, cwd, base, p);
  const partner = await renamePartnerOf(git, execFn, cwd, base, p);
  if (partner !== undefined) {
    throw new Error(
      `a rename pairs deferred protected path "${p}" with "${partner}" — it cannot be discarded one side at a time; drop the rename or grant the path`,
    );
  }
  // Exact-case presence: git's pathspec matching follows core.ignorecase, so a
  // same-letters-different-case entry would otherwise be acted on by this name.
  const committed = nul(
    (
      await git([...DISCARD_GIT_ARGV, "diff", "--name-only", "-z", base, "HEAD"], {
        cwd,
        maxBuffer: DISCARD_NAME_MAX_BUFFER,
        timeout: DEFAULT_GIT_TIMEOUT_MS,
      })
    ).stdout,
  );
  const dirty = (await statusEntries(git, cwd)).map((e) => e.path);
  const twin = [...committed, ...dirty].find((n) => n !== p && n.toLowerCase() === p.toLowerCase());
  if (twin !== undefined) {
    throw new Error(
      `refusing to discard "${p}": the worktree also holds "${twin}", which differs only in case — a discard by this name could act on that file`,
    );
  }
  const inCommit = committed.includes(p);
  const inStatus = dirty.includes(p);
  if (!inCommit && !inStatus) return false;
  const atBase = nul(
    (
      await git(
        [...DISCARD_GIT_ARGV, "--literal-pathspecs", "ls-tree", "-z", "--name-only", base, "--", p],
        { cwd, maxBuffer: DISCARD_NAME_MAX_BUFFER, timeout: DEFAULT_GIT_TIMEOUT_MS },
      )
    ).stdout,
  ).includes(p);
  // Captured BEFORE the first mutation: the rollback needs to know whether HEAD
  // has this path, and asking after a failed `rm` cannot answer that.
  const atHead = await existsAtHead(git, cwd, p);
  try {
    if (atBase) {
      await git([...DISCARD_GIT_ARGV, "--literal-pathspecs", "checkout", base, "--", p], {
        cwd,
        maxBuffer: DISCARD_WRITE_MAX_BUFFER,
        timeout: DEFAULT_GIT_TIMEOUT_MS,
      });
    } else {
      await git(
        [
          ...DISCARD_GIT_ARGV,
          "--literal-pathspecs",
          "rm",
          "-r",
          "-f",
          "--ignore-unmatch",
          "-q",
          "--",
          p,
        ],
        { cwd, maxBuffer: DISCARD_WRITE_MAX_BUFFER, timeout: DEFAULT_GIT_TIMEOUT_MS },
      );
      await rm(join(cwd, p), { force: true, recursive: true });
    }
    if (inCommit) await revertCommit(git, cwd, p, atHead);
  } catch (err) {
    // `revertCommit` has already restored and re-thrown its own case; anything
    // else that broke after the first mutation is rolled back here rather than
    // reported against a half-applied tree.
    if (errText(err).includes("restored to HEAD")) throw err;
    try {
      await restoreToHead(git, cwd, p, atHead);
    } catch (restoreErr) {
      throw new Error(
        `discarding "${p}" failed (${errText(err)}) and restoring it to HEAD also failed (${errText(restoreErr)})`,
      );
    }
    throw new Error(
      `discarding "${p}" failed, and the path was restored to HEAD (${errText(err)})`,
    );
  }
  return true;
}
