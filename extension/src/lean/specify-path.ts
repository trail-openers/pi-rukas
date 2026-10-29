/**
 * lean/specify-path — the per-path shape judgements the submit boundary calls.
 *
 * Split from `specify-tree.ts` for the file-size cap; it is the same boundary,
 * and `specify-tree.ts` re-exports every symbol here so its importers (and its
 * smoke tests) never learn about the seam. Three pure functions, each answering
 * one question about ONE path, with no git and no model in the loop:
 *
 *   - `pathProblem`      — is this a worktree-relative path that does not
 *     traverse and avoids the directories a test never lives in;
 *   - `normaliseRelPath` — the canonical git-relative spelling two spellings of
 *     one file must collapse to, or the frozen/base checks can be dodged by
 *     punctuation;
 *   - `fileProblem`      — is the thing at that path an ordinary file of THIS
 *     worktree, rather than a link, a fifo, or a hard link to somewhere else.
 */

import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/** A directory segment the step never accepts a test file inside. */
const FORBIDDEN_SEGMENTS = [".pi", ".git", "node_modules"] as const;

/**
 * Why a NORMALISED relative path is not an acceptable test file, or undefined
 * when it is. Absolute paths are caught by the caller before normalisation
 * (normalising `/etc/passwd` would erase the fact that it is absolute); this
 * refuses traversal and the directories a test never legitimately lives in.
 */
export function pathProblem(p: string): string | undefined {
  const segments = p.split(/[\\/]+/);
  if (segments.includes("..")) return `path contains ".." : ${p}`;
  for (const seg of segments) {
    for (const bad of FORBIDDEN_SEGMENTS) if (seg === bad) return `path under ${bad}/: ${p}`;
  }
  if (segments.some((s) => s === "")) return `empty path segment in ${p}`;
  return undefined;
}

/** Collapse `./x`, `x/./y` and a trailing slash to the git-relative form. */
export function normaliseRelPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Why this path in `wt` is not a file the step may capture, or undefined when
 * it is. The path arrives already normalised and known to exist.
 *
 * The four checks are what a child cannot get past:
 *
 *   - `lstat` (NOT `stat`) so a symlink is a symlink and not the file it
 *     points at — following one would capture, hash and commit bytes from
 *     anywhere on the host;
 *   - a REGULAR file, so a fifo, socket, device or directory is refused;
 *   - `nlink === 1`, so a HARD LINK cannot impersonate a file of the worktree.
 *     A hard link is not a symlink — `lstat` sees an ordinary file and
 *     `realpath` stays inside the tree — so this is the only check that
 *     catches it, and the one the path checks alone cannot: the bytes it
 *     shares with an outside file would have been frozen and committed;
 *   - `realpath` of the file inside `realpath` of the worktree, so no
 *     component of the path escapes through a linked parent.
 */
export function fileProblem(wt: string, rel: string): string | undefined {
  const abs = path.join(wt, rel);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    return `file ${rel} could not be read`;
  }
  if (st.isSymbolicLink()) return `file ${rel} is a symlink, which the step never follows`;
  if (!st.isFile()) return `file ${rel} is not a regular file`;
  if (st.nlink !== 1) return `file ${rel} has ${st.nlink} hard links — not a file of this worktree`;
  let realFile: string;
  let realTree: string;
  try {
    realFile = realpathSync(abs);
    realTree = realpathSync(wt);
  } catch {
    return `file ${rel} could not be resolved inside ${wt}`;
  }
  if (realFile !== realTree && !realFile.startsWith(realTree + path.sep))
    return `file ${rel} resolves outside the worktree (${realFile})`;
  return undefined;
}
