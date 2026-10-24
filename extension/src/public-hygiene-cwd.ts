/**
 * public-hygiene-cwd — where a command runs, and where it may read a file from
 * (#1788 round 4).
 *
 * Two questions the guard cannot answer from the tool call alone, split out of
 * `public-hygiene-guard.ts`/`public-hygiene-scan.ts` so each stays under the
 * §12 size cap: WHICH clone does this push's git read, and WHICH directories may
 * a named body file live in. Both are answered off the command text, because the
 * tool call carries neither a cwd of its own nor a notion of a chain.
 *
 * ## The directory, per segment
 *
 * `toolCwd` gives the best available directory, and for a chained command it is
 * the wrong one: `cd .worktrees/issue-9 && git push` runs in the worktree while
 * this process sits at the repo root. Scanning the wrong clone is worse than
 * scanning none — the range it prints is a real range unrelated to what is being
 * published, and it reads as clean.
 *
 * A `git -C <dir>` belongs to the segment that wrote it and to NO other, so each
 * simple command starts its read back at the tool cwd. Carrying the assignment
 * across the chain instead resolves `git -C one push … && git -C two push …` to
 * `one/two` — a path in neither tree — and the scan then reads a range nobody is
 * publishing, or fails on a directory that does not exist and reports an
 * unreadable push for a command that was perfectly readable. With the reset the
 * first push resolves to `one` and the second to `two`, which is what git itself
 * does with them. `cd` is the deliberate exception: it is the shell moving the
 * rest of the chain, so a `cd` carries forward until a later `cd` replaces it.
 *
 * ## The directories a body file may live in
 *
 * The OS temp dir (where the forge adapter legitimately writes a body, and where
 * an operator's scratch lives), the command's own cwd tree, and the git top-level
 * of that directory. The last one is the /work driver's shape: it and its agents
 * write PR and handoff bodies under `<repo>/tmp/issue-<N>/`, which is inside the
 * repository and outside the OS temp dir, so a rule that admitted only the temp
 * dir refused the driver's own handoff comment. The git top-level is resolved
 * with `git rev-parse --show-toplevel` and falls back to the cwd when git cannot
 * answer — a resolution failure must not widen what is readable, and must not
 * refuse a legitimate file either, because the CONTENT check is what decides.
 * A path outside every root is refused on its PATH alone and never opened.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleCommands } from "./bash-destructive-write.ts";

/** The git program, assembled from fragments like the guard assembles its verbs. */
const GIT_PROGRAM = ["gi", "t"].join("");

/**
 * The directory the push's git reads must run in.
 *
 * The answer is the LAST segment that moved the git, because that is the last
 * push this process could have run; a caller that needs one particular push out
 * of a two-push chain asks about that push's own segment.
 */
export function pushGitCwd(toolCwdValue: string, command: string): string {
  const dirs = segmentCwds(toolCwdValue, command);
  return dirs[dirs.length - 1] ?? toolCwdValue;
}
/**
 * One directory per simple command of `command`, in order: where that segment's
 * git runs. A chain whose segments disagree is exactly what a single answer
 * cannot represent, so the per-segment list is the primitive and `pushGitCwd`
 * is its last-mover reading of it.
 */
export function segmentCwds(toolCwdValue: string, command: string): string[] {
  const dirs: string[] = [];
  // The directory a `cd` established, carried forward as a shell carries it;
  // undefined until the first `cd` of the chain.
  let fromCd: string | undefined;
  for (const argv of simpleCommands(command)) {
    // Each segment begins where the shell begins it: at the tool cwd, unless a
    // `cd` moved it. A `git -C` from an earlier segment does not come along.
    let dir = fromCd ?? toolCwdValue;
    for (let i = 0; i < argv.length; i++) {
      const w = argv[i] ?? "";
      const base = path.basename(w);
      // `git -C <dir> push …` — git's one positional global, and the only one
      // that moves the work tree: `--git-dir` names the `.git` DIRECTORY, so
      // resolving the scan there points every git call at a tree that is not a
      // checkout and turns a real push into an unreadable range.
      if (w === "-C" && i === 1) {
        const target = argv[i + 1];
        if (target !== undefined && target !== "") {
          dir = path.resolve(dir, target);
          break;
        }
      }
      // `cd <dir> && …` — a shell prefix that moves the rest of the chain.
      if (base === "cd" && argv.length >= 2) {
        const target = argv[1] ?? "";
        if (target !== "" && !target.startsWith("-")) {
          dir = path.resolve(dir, target);
          fromCd = dir;
        }
        break;
      }
    }
    dirs.push(dir);
  }
  return dirs;
}

/**
 * The directories a named body file may live in: the OS temp dir, the command's
 * own cwd tree, and the git top-level of that directory (the repository, which
 * is where `<repo>/tmp/issue-<N>/` handoff and PR bodies are written).
 */
export function admissibleRoots(cwd: string): string[] {
  const roots: string[] = [];
  for (const dir of [cwd, tmpdir(), gitTopLevel(cwd)]) {
    if (dir === "") continue;
    try {
      roots.push(realpathSync(dir));
    } catch {
      // A root that cannot be resolved is still a root: the check is about the
      // PATH, and refusing to name a directory is not a reason to read files
      // from anywhere.
      roots.push(path.resolve(dir));
    }
  }
  return roots;
}

/**
 * The repository containing `cwd`, or "" when git cannot say. Resolved through
 * argv (never a shell) so a path with spaces or metacharacters stays one
 * argument; any failure is "" and the caller simply has one fewer root.
 */
export function gitTopLevel(cwd: string): string {
  try {
    const out = execFileSync(GIT_PROGRAM, ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const top = out.trim();
    return top === "" ? "" : top;
  } catch {
    return "";
  }
}

/** Is `target` `root` itself or below it? Compares realpaths, so `..` cannot escape. */
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
