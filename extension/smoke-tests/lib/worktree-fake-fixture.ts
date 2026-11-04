import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { integrateBackupRef } from "../../src/work-driver-integrate-cycle.ts";
import type { ExecFn } from "../../src/worktree.ts";
import { gitTestEnv } from "./git-test-env.ts";

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
  // `shell` is the caller's interpreter choice for the STRING form and is never
  // an execFile option: with `shell` set, execFile joins its argv into one
  // string for that shell, so the `-c`/`cmd` pair below would run `sh -c git`
  // (#1981).
  const { shell, ...rest } = o ?? {};
  const opts = {
    cwd: rest.cwd,
    maxBuffer: rest.maxBuffer ?? 8 * 1024 * 1024,
    // #1396 round 3 — the fixture honours the caller's bound, so a test that
    // asserts a timeout was threaded through is asserting something real about
    // this executor rather than about an ignored option.
    ...(rest.timeout !== undefined ? { timeout: rest.timeout } : {}),
    // Both branches run git for real, and `execFile`/`exec` with no `env`
    // inherit the REAL environ on bun: an inherited `GIT_DIR` retargets these
    // calls ahead of `cwd` (#1981). The caller's own env still wins, because a
    // test that pins one (a non-interactive ssh env, say) means it.
    env: o?.env ? { ...gitTestEnv(), ...o.env } : gitTestEnv(),
  };
  const { stdout } = o?.argv
    ? await execFileP(cmd, o.argv, opts)
    // The shell branch names its own env: the gate credits only a git/shell
    // call whose own options carry the scrub, and this branch is the one that
    // runs the driver’s git commands.
    : await execFileP(shell ?? "/bin/sh", ["-c", cmd], { ...opts, env: opts.env });
  return { stdout };
};

/**
 * `realExec` that folds the child's stderr into the thrown message, so a failing
 * git call shows WHY in the test log. Same behaviour otherwise.
 */
export const realExecWithStderr = async (
  cmd: string,
  o?: { cwd?: string; maxBuffer?: number; timeout?: number; shell?: string },
): Promise<{ stdout: string }> => {
  try {
    return await realExec(cmd, o);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`${err.message}\n${err.stderr ?? ""}`);
  }
};

/** Run git for real in `cwd`. */
export const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd, env: gitTestEnv() });

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

/**
 * The per-issue integrate backup ref (#1173 / #1396), from the ONE producer
 * (`integrateBackupRef` in `work-driver-integrate-cycle.ts`) — so a test that
 * asserts a ref name cannot drift from the ref the code writes. Tests assert
 * against this rather than a literal.
 */
export const integrateBackupRefFor = (issue: number): string => integrateBackupRef(issue);

/** The ref under which every integrate backup for issue 17 lives in the fixtures. */
export const ISSUE_17_BACKUP_REF = integrateBackupRef(17);
