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
 *  - a path under a symlinked directory, a directory-shaped path, or a rename
 *    pairing the path with another (committed or staged);
 *  - a name that differs only in case from the path in the same worktree. Git's
 *    pathspec matching follows core.ignorecase, so every removal and restore is
 *    gated on an EXACT-case match in base, the index or the status entries.
 *
 * A failed revert commit puts the path back to HEAD in the index and worktree
 * before the failure is reported, so the branch is left as the developer had it.
 *
 * Import chain: work-driver-verify-develop.ts → this file → work-develop-git.ts +
 * work-driver-protected-grant.ts (acyclic). Only the operator's grant is
 * honoured (`grant`), never the state file (#1090).
 */

import { lstat, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type ExecFn, errText, isValidBaseSha, runGit } from "./work-develop-git.ts";
import { ungrantedProtectedPaths } from "./work-driver-protected-grant.ts";

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
        if (await discardOne(git, cwd, base, p)) {
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
    const diff = (await git(["diff", "--name-only", base, "HEAD"], { cwd })).stdout.trim();
    const tracked = (
      await git(["status", "--porcelain", "--untracked-files=no"], { cwd })
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

/**
 * Pairs `(from, to)` of every rename or copy in git output. `nameStatus` selects
 * `diff --name-status -z` (status, from, to) over `status --porcelain -z`
 * (XY to, from), the two shapes the discard pass reads.
 */
function renamePairsOf(out: string, nameStatus: boolean): Array<[string, string]> {
  const f = out.split("\0");
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < f.length; i++) {
    const tok = f[i] ?? "";
    if (nameStatus) {
      if (tok[0] === "R" || tok[0] === "C") {
        pairs.push([f[i + 1] ?? "", f[i + 2] ?? ""]);
        i += 2;
      } else {
        i += 1;
      }
    } else if (tok.length >= 4 && (tok[0] === "R" || tok[0] === "C")) {
      pairs.push([f[i + 1] ?? "", tok.slice(3)]);
      i += 1;
    }
  }
  return pairs;
}

/** Every path a `status --porcelain -z` output names: each entry, and a rename's source. */
function statusNames(out: string): string[] {
  const f = out.split("\0");
  const names: string[] = [];
  for (let i = 0; i < f.length; i++) {
    const tok = f[i] ?? "";
    if (tok.length < 4) continue;
    names.push(tok.slice(3));
    if (tok[0] === "R" || tok[0] === "C") {
      names.push(f[i + 1] ?? "");
      i += 1;
    }
  }
  return names;
}

/**
 * The other side of a committed or staged rename that involves `p`, if any. A
 * rename cannot be discarded one side at a time: reverting only the deferred side
 * would leave its content under the unprotected name (or delete the source), so
 * the caller fails the discard instead.
 */
async function renamePartnerOf(
  git: Git,
  cwd: string,
  base: string,
  p: string,
): Promise<string | undefined> {
  const committed = (await git(["diff", "--name-status", "-M", "-z", base, "HEAD"], { cwd }))
    .stdout;
  const staged = (await git(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd }))
    .stdout;
  const pairs = [...renamePairsOf(committed, true), ...renamePairsOf(staged, false)];
  for (const [from, to] of pairs) {
    if (from === p) return to;
    if (to === p) return from;
  }
  return undefined;
}

/**
 * `rm` follows a symlinked leading directory, so a deferred path under a symlink
 * could delete outside the worktree. Refused before anything is touched.
 */
async function refuseSymlinkedParent(cwd: string, p: string): Promise<void> {
  const parts = p.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = join(cwd, ...parts.slice(0, i));
    try {
      if ((await lstat(dir)).isSymbolicLink()) {
        throw new Error(
          `refusing to discard "${p}": its parent "${parts.slice(0, i).join("/")}" is a symlink`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
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
  const baseEntry = (await git(["ls-tree", base, "--", p], { cwd })).stdout;
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
 * Put the deferred path back to HEAD after a revert commit that did not land, so
 * the index and worktree match the branch as the developer left it, then fail.
 */
async function revertCommit(git: Git, cwd: string, p: string): Promise<void> {
  try {
    await git(
      [
        "--literal-pathspecs",
        "commit",
        "-m",
        `fix(work): discard edit to deferred protected path ${p}`,
        "--",
        p,
      ],
      { cwd },
    );
  } catch (err) {
    try {
      await git(["--literal-pathspecs", "checkout", "HEAD", "--", p], { cwd });
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
async function discardOne(git: Git, cwd: string, base: string, p: string): Promise<boolean> {
  if (isAbsolute(p) || p.split("/").includes("..")) {
    throw new Error(`refusing to restore an unsafe path "${p}"`);
  }
  await refuseSymlinkedParent(cwd, p);
  await refuseDirectory(git, cwd, base, p);
  const partner = await renamePartnerOf(git, cwd, base, p);
  if (partner !== undefined) {
    throw new Error(
      `a rename pairs deferred protected path "${p}" with "${partner}" — it cannot be discarded one side at a time; drop the rename or grant the path`,
    );
  }
  // Exact-case presence: git's pathspec matching follows core.ignorecase, so a
  // same-letters-different-case entry would otherwise be acted on by this name.
  const committed = nul((await git(["diff", "--name-only", "-z", base, "HEAD"], { cwd })).stdout);
  const dirty = statusNames(
    (await git(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd })).stdout,
  );
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
    (await git(["--literal-pathspecs", "ls-tree", "-z", "--name-only", base, "--", p], { cwd }))
      .stdout,
  ).includes(p);
  if (atBase) {
    await git(["--literal-pathspecs", "checkout", base, "--", p], { cwd });
  } else {
    await git(["--literal-pathspecs", "rm", "-r", "-f", "--ignore-unmatch", "-q", "--", p], {
      cwd,
    });
    await rm(join(cwd, p), { force: true, recursive: true });
  }
  if (inCommit) await revertCommit(git, cwd, p);
  return true;
}
