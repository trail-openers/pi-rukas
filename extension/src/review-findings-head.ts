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
 * no-line finding. `error`: git itself failed (bad sha, I/O) — the round cannot
 * be recorded.
 */
export type HeadLines =
  | { kind: "lines"; lines: string[] }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

/** A repo-relative path that git can show at a commit without option injection. */
function safeRepoPath(p: string): boolean {
  if (!p || p.startsWith("-") || p.startsWith("/") || /[\0\n]/.test(p)) return false;
  return !p.split("/").includes("..");
}

/** git's own wording for "this path is not in that commit" (LC_ALL=C pins it). */
const PATH_ABSENT_AT_HEAD = /does not exist in|exists on disk, but not in/;

/**
 * The lines of `file` at `sha`. git words "path absent" the same way for an
 * unreadable commit, so the commit is checked first. An empty file is never
 * returned for a git failure: it would give every finding a fake identity.
 */
export async function readHeadLines(cwd: string, sha: string, file: string): Promise<HeadLines> {
  if (!safeRepoPath(file)) return { kind: "missing" };
  try {
    await execFileP("git", ["-C", cwd, "cat-file", "-e", `${sha}^{commit}`]);
  } catch (err) {
    return {
      kind: "error",
      reason: `cannot read ${file} at ${sha.slice(0, 12)}: not a commit in this clone (${(err as Error).message.slice(0, 80)})`,
    };
  }
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "show", `${sha}:${file}`], {
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    return { kind: "lines", lines: stdout.split("\n") };
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (PATH_ABSENT_AT_HEAD.test(stderr)) return { kind: "missing" };
    return {
      kind: "error",
      reason: `cannot read ${file} at ${sha.slice(0, 12)}: ${(err as Error).message.slice(0, 120)}`,
    };
  }
}
