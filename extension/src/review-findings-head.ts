/**
 * review-findings-head — reads a file's lines at the reviewed commit for the
 * findings memory (#1105). The one git seam of review-findings-store.ts, kept
 * apart so the store stays under the file-size cap. Nothing here writes to disk.
 *
 * A path absent from a readable commit is `missing`; any other git failure is an
 * `error`, which refuses the whole round — no finding is suppressed or resolved
 * on evidence that could not be read.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * `lines`: the file exists at the commit. `missing`: the commit is readable but
 * the path is not in it (a lens cited a wrong or stale path) — recorded as a
 * no-line finding and its rows are path-gone. `invalid`: the path cannot name a
 * file at the commit (unsafe, or a directory/tree) — a no-line finding, but its
 * rows are carried, never path-gone. `error`: git itself failed (bad sha, I/O)
 * — the round cannot be recorded.
 */
export type HeadLines =
  | { kind: "lines"; lines: string[] }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "error"; reason: string };

/** A repo-relative path that git can show at a commit without option injection. */
function safeRepoPath(p: string): boolean {
  if (!p || p.startsWith("-") || p.startsWith("/") || /[\0\n]/.test(p)) return false;
  return !p.split("/").includes("..");
}

/**
 * The lines of `file` at `sha`. The commit is checked first, so a git failure
 * after that is never read as "path absent". Absence is decided by output, not by
 * git's error wording: `ls-tree` prints nothing for a path that is not in the
 * commit (exit 0), and `--literal-pathspecs` stops a glob-looking path matching
 * other entries. An empty file is never returned for a git failure: it would give
 * every finding a fake identity.
 */
export async function readHeadLines(cwd: string, sha: string, file: string): Promise<HeadLines> {
  if (!safeRepoPath(file)) return { kind: "invalid" };
  try {
    await execFileP("git", ["-C", cwd, "cat-file", "-e", `${sha}^{commit}`]);
  } catch (err) {
    return {
      kind: "error",
      reason: `cannot read ${file} at ${sha.slice(0, 12)}: not a commit in this clone (${(err as Error).message.slice(0, 80)})`,
    };
  }
  // `ls-tree` on the path itself lists that one entry: empty output means the
  // path is not in the commit, and the entry's type says whether it is a blob.
  // `git show` exits 0 with a tree listing for a directory, so only a blob is read.
  let entry: string;
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      cwd,
      "--literal-pathspecs",
      "ls-tree",
      sha,
      "--",
      file,
    ]);
    entry = stdout.split("\n")[0] ?? "";
  } catch (err) {
    return {
      kind: "error",
      reason: `cannot read ${file} at ${sha.slice(0, 12)}: ${(err as Error).message.slice(0, 120)}`,
    };
  }
  if (entry === "") return { kind: "missing" };
  // Format: `<mode> SP <type> SP <object> TAB <path>`.
  if (entry.split(/\s/)[1] !== "blob") return { kind: "invalid" };
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "show", `${sha}:${file}`], {
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    return { kind: "lines", lines: stdout.split("\n") };
  } catch (err) {
    return {
      kind: "error",
      reason: `cannot read ${file} at ${sha.slice(0, 12)}: ${(err as Error).message.slice(0, 120)}`,
    };
  }
}
