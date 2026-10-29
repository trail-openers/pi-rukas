/**
 * lean/specify-path — the per-path shape judgements the submit boundary calls.
 *
 * Split from `specify-tree.ts` for the file-size cap; it is the same boundary.
 * Four judgements, each answering one question about ONE path:
 *
 *   - `pathProblem`      — is this a worktree-relative path that does not
 *     traverse and avoids the directories a test never lives in;
 *   - `normaliseRelPath` — the canonical git-relative spelling two spellings of
 *     one file must collapse to, or the frozen/base checks can be dodged by
 *     punctuation;
 *   - `fileProblem`      — is the thing at that path an ordinary file of THIS
 *     worktree, rather than a link, a fifo, or a hard link to somewhere else;
 *   - `existsInCommit`   — is that name an object in the run's BASE tree, which
 *     is the only read that tells "the child wrote this" from "it was checked
 *     out at me".
 *
 * The last is the module's one git read. Everything else here is pure.
 */

import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isFullCommitSha } from "../commit-sha.ts";
import type { ExecFn } from "../worktree.ts";
import { NO_HOOKS, SpecifyResetError } from "./specify-reset.ts";

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

/**
 * Is `rel` an object in the tree of `ref`? Asked of git, not of the working tree.
 *
 * The boundary in `validateSubmitRows` needs this to refuse a submitted test the
 * run's base ALREADY has — a tracked test the child never wrote is not a new
 * acceptance test, whatever it declares about it — and only a read of the base
 * tree answers it: a working-tree check cannot tell "the child wrote this" from
 * "it was checked out at me".
 *
 * The read is `git ls-tree -z --full-tree --literal-pathspecs <ref> -- <rel>`,
 * whose answer is its STDOUT, not its stderr:
 *
 *   - exit 0 and empty stdout → **false**: no such object, the file is new;
 *   - exit 0 and non-empty stdout → **true**, and a TREE counts too — which is
 *     right, because a directory at that path is not a new file (the boundary's
 *     `fileProblem` refuses it as a test regardless);
 *   - any rejection → **throw**. The child's path never enters the judgement.
 *
 * The previous shape probed with `cat-file -e` and read git's *stderr* to decide
 * whether a refusal meant absence. Git interpolates the child-chosen path into
 * that message, so a file named `does not exist in 'x'.ts` could make any fault
 * read as absence — and a repository git cannot read would certify that EVERY
 * submitted test is new, passing the exact fraud the newness rule exists to
 * refuse while reporting total confidence. There is no wording left to judge:
 * presence and absence are a byte count on a channel the path cannot write to.
 *
 * `ref` is a full lowercase oid or this throws (the shape check
 * `lean/base-proof.ts` applies to a run's base): a moving name or a revision
 * chain silently changes which tree newness is judged against.
 *
 * `--end-of-options` closes the ref so a path the child spelled cannot be read
 * as a flag, `--` is the standard separator between rev and pathspec, and
 * `--literal-pathspecs` (a top-level option, as `commitTestFiles` passes it)
 * makes `tests/[a]x.test.ts` one file rather than a glob onto someone else's.
 */
export async function existsInCommit(
  exec: ExecFn,
  cwd: string,
  ref: string,
  rel: string,
): Promise<boolean> {
  if (!isFullCommitSha(ref))
    throw new SpecifyResetError(
      `could not read the base commit to check whether ${rel} is new: \`${ref}\` is not a full commit sha`,
    );
  try {
    const r = await exec("git", {
      argv: [
        ...NO_HOOKS,
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        "--full-tree",
        "--end-of-options",
        ref,
        "--",
        rel,
      ],
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return (r.stdout ?? "") !== "";
  } catch (err) {
    // git's own message rides along: a handback that says only "could not read
    // the base commit" sends an operator hunting for a missing file in a
    // repository whose object store is simply broken.
    throw new SpecifyResetError(
      `could not read the base commit ${ref} to check whether ${rel} is new: ${(err as Error).message}`,
    );
  }
}
