/**
 * review-findings-head — reads a file's lines at the reviewed commit for the
 * findings memory (#1105). The one git seam of review-findings-store.ts, kept
 * apart so the store stays under the file-size cap. Nothing here writes to disk,
 * and the `HeadState` judgement (which state a row may be judged on) lives with
 * the rule that makes it, in review-findings-fate.ts / review-findings-round.ts.
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

/** A head state the store can judge a row against: every `HeadLines` but a git failure. */
export type HeadState = Exclude<HeadLines, { kind: "error" }>;

/**
 * A repo-relative path that git can show at a commit without option injection.
 * Empty, `.`, absolute, trailing-slash, `..`, and non-canonical paths (`./x`,
 * `a//b`, `a/./b`) are refused: `git show` of such a path can yield a tree
 * listing that would be read as file lines, and a lens-cited spelling of a real
 * file must never resolve as path-gone.
 */
function safeRepoPath(p: string): boolean {
  if (!p || p.startsWith("-") || p.startsWith("/")) return false;
  if (/[\0\n]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
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
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    return {
      kind: "error",
      reason: `cannot read ${file}: "${sha.slice(0, 40)}" is not a commit SHA`,
    };
  }
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
      "--full-tree",
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
  // Format: `<mode> SP <type> SP <object> TAB <path>`. Anything else is not git
  // output we understand, so it is an error, not a guess about the type.
  const parsed = /^\d{6} (blob|tree|commit) [0-9a-f]+\t/.exec(entry);
  if (!parsed) {
    return {
      kind: "error",
      reason: `cannot read ${file} at ${sha.slice(0, 12)}: unrecognised ls-tree output`,
    };
  }
  if (parsed[1] !== "blob") return { kind: "invalid" };
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
