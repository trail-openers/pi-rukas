/**
 * review-findings-head — reads a finding's cited file at the reviewed commit
 * (#1105), split from review-findings-store.ts (the 500-line gate). A path
 * absent from a readable commit is `missing`; any other git failure is an
 * `error`, never an empty file.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** A repo-relative path that git can show at a commit without option injection. */
function safeRepoPath(p: string): boolean {
  if (!p || p.startsWith("-") || p.startsWith("/") || /[\0\n]/.test(p)) return false;
  return !p.split("/").includes("..");
}

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

/** git's own wording for "this path is not in that commit" (LC_ALL=C pins it). */
const PATH_ABSENT_AT_HEAD = /does not exist in|exists on disk, but not in/;

/**
 * The lines of `file` at `sha`. A path absent from a readable commit is
 * `missing`; any other git failure is an `error`, never an empty file: an empty
 * file would give every finding a fake identity and suppress nothing on the
 * wrong evidence. git words "path absent" the same way for an unreadable commit,
 * so the commit is checked first.
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
