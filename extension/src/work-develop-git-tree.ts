/**
 * work-develop-git-tree — the ONE bounded worktree read the develop step's
 * verdicts are computed from (#1403, #1768).
 *
 * Both halves of the develop classification ask the same question of a
 * worktree — a dead child's (#1403) and a child that exited 0 without
 * committing its own work (#1768) — and they must not answer it with two
 * readers: the crash record's dirt list and the unfinished record's would
 * drift, and one of them would be lying. One argv, one `-z` parse, one
 * timeout, one artefact filter.
 *
 * Why the bound instead of `worktreeStatus`: that helper takes a `GitExec`
 * and trusts it to return. A hung `git status` — a stale worktree, or a lock
 * the child that just died left behind — would then block the develop
 * fan-out indefinitely, past the point where its write-ahead dispatch
 * marker is already recorded. Here the same read degrades to `unreadable`,
 * which every caller already treats as "the driver cannot certify this", the
 * honest answer and never a clean one.
 */

import {
  type ExecFn,
  type StatusEntry,
  commitEntriesOf,
  errText,
  parseStatus,
} from "./work-develop-git.ts";

/** How long one git read waits before the tree is called unreadable. Generous
 *  for a healthy tree (a big monorepo `git status` is seconds) and short
 *  enough that a hung git cannot stall the develop fan-out. */
const TREE_READ_TIMEOUT_MS = 30_000;

/** The bounded status read, shared by both develop verdicts. Returns the
 *  parsed entries, or the reason the tree could not be read — never an empty
 *  list standing in for an unreadable one. */
export async function readTreeBounded(
  execFn: ExecFn,
  cwd: string,
): Promise<{ entries: StatusEntry[] } | { unreadable: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = execFn("git", {
      cwd,
      // -uall: an untracked directory is listed file by file, so every path is
      // a file a later `git diff --cached --name-only` confirms as staged.
      argv: ["status", "--porcelain", "-z", "--untracked-files=all"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: TREE_READ_TIMEOUT_MS,
    });
    const settled = await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`git status timed out after ${TREE_READ_TIMEOUT_MS}ms`)),
          TREE_READ_TIMEOUT_MS,
        );
      }),
    ]);
    const parsed = parseStatus(settled.stdout);
    return Array.isArray(parsed)
      ? { entries: commitEntriesOf(parsed) }
      : { unreadable: parsed.unreadable };
  } catch (err) {
    return { unreadable: errText(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The classifier's own status reader in the shape `classifyDevelopPass`
 *  consumes: the same bounded read, returning the raw `-z` parse (a rename
 *  contributes both of its paths) or the reason it could not be read.
 *
 *  The `unreadable` case is passed through and never collapsed to an empty
 *  list: #1403's crash record reports dirt and readability as two separate
 *  fields, and an empty list read as "readable and clean" is the confident-
 *  wrong record that issue exists to remove. */
export function treeReader(
  execFn: ExecFn,
): (cwd: string) => Promise<ReturnType<typeof parseStatus>> {
  return async (cwd) => {
    const read = await readTreeBounded(execFn, cwd);
    return "entries" in read ? read.entries : { unreadable: read.unreadable };
  };
}
