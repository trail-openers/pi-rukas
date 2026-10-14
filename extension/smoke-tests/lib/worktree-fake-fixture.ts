import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExecFn } from "../../src/worktree.ts";

/**
 * Shared fixtures for the worktree smoke tests (#475, #654, #1170).
 *
 * Two kinds of evidence the worktree tests need:
 *  - real git: `realExec` / `git` run against an actual temp repository —
 *    the load-bearing evidence;
 *  - injected exec: a real temp directory stands in for a worktree on disk,
 *    so inspectors that check the path see something real, and
 *    `rev-parse --show-toplevel` answers as a real worktree would.
 */

const execFileP = promisify(execFile);

/**
 * Run a shell command for real, in the given cwd. An `argv` option runs that
 * program directly (no shell), as the production exec does for JSON-free calls.
 */
export const realExec: ExecFn = async (cmd, o) => {
  const opts = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
  const { stdout } = o?.argv
    ? await execFileP(cmd, o.argv, opts)
    : await execFileP("/bin/sh", ["-c", cmd], opts);
  return { stdout };
};

/**
 * `realExec` that folds the child's stderr into the thrown message, so a failing
 * git call shows WHY in the test log. Same behaviour otherwise.
 */
export const realExecWithStderr = async (
  cmd: string,
  o?: { cwd?: string; maxBuffer?: number },
): Promise<{ stdout: string }> => {
  try {
    return await realExec(cmd, o);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`${err.message}\n${err.stderr ?? ""}`);
  }
};

/** Run git for real in `cwd`. */
export const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

/** A fresh temp directory to act as a repo root. The caller removes it. */
export function makeFakeRepoRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** `<root>/.worktrees/<name>` as a real directory with a `.git` file (#1170). */
export function makeFakeWorktreeDir(root: string, name: string): string {
  const dir = path.join(root, ".worktrees", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".git"), "gitdir: /dev/null\n");
  return dir;
}

/** What a real worktree answers to `git rev-parse --show-toplevel` run from `cwd`. */
export function toplevelAnswer(cwd: string | undefined): { stdout: string } {
  return { stdout: realpathSync(cwd ?? "") + "\n" };
}
