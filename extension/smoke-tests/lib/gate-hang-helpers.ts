/**
 * #1427 fix round — the exec stub shared by the two hang tests that drive a
 * KILLED gate run through the real seams
 * (`test-work-driver-verify-consolidated-walker.ts`,
 * `test-gate-hang-uniqueness.ts`).
 *
 * Lives in `smoke-tests/lib/` rather than beside the tests because
 * `test-file-size-limit.ts` scans every `.ts` under `smoke-tests/` — a helper
 * next to the tests would count toward the 500-line gate.
 *
 * The stub answers every `git` call with a REAL git run (the consolidated
 * probe needs a working checkout / cherry-pick) and every non-git call with
 * the rejection `execTree` produces when it kills a run at its bound.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandOf } from "./argv-shell.ts";
import { gitTestEnv } from "./git-test-env.ts";

const execFileP = promisify(execFile);

/** The test the fake runner claims is stuck; the tests grep for it. */
export const STUCK_TEST = "repo::sync::tests::pull_then_fetch";

/** The process the fake walker claims is still holding on. */
export const SENTINEL_ARGS = "SENTINEL-git-remote-https-origin";

export interface HangProcessLike {
  pid: number;
  ppid: number;
  etime: string;
  args: string;
}

export const HUNG_STREAM = [
  "running 212 tests",
  "test git::fetch::tests::ok ... ok",
  `test ${STUCK_TEST} has been running for over 60 seconds`,
].join("\n");

/**
 * Run a shell command for real (the git plumbing of the fixtures).
 *
 * The scrubbed env is not decoration: `killerExec` below routes EVERY git call
 * through this function, so with no `env` here a hostile `GIT_DIR` in the test
 * process would retarget those commits — git honours it ahead of `cwd` — and
 * exit 0 while writing into whoever's repository it names (#1981).
 */
export const sh = (cwd: string, cmd: string) =>
  execFileP("/bin/sh", ["-c", cmd], { cwd, env: gitTestEnv() });

/** Run git for real. */
export const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd, env: gitTestEnv() });

/** Rejection shaped exactly like `execTree`'s timeout: killed + the group it killed. */
export function killedError(
  cmd: string,
  hangStream: string | undefined,
  treePid = 7000,
): Error {
  const e = new Error(`Command failed: ${cmd}`) as Error & {
    stdout?: string;
    stderr?: string;
    killed?: boolean;
    treePid?: number;
  };
  e.stdout = "";
  e.stderr = hangStream ?? "";
  e.killed = true;
  e.treePid = treePid;
  return e;
}

/**
 * An exec that runs git for real and kills everything else, recording each
 * killed gate command so a test can tell a per-worktree run from the
 * consolidated probe.
 */
export function killerExec(opts: { hangStream?: string; treePid?: number }) {
  const killed: string[] = [];
  const exec = async (cmd: string, o?: { cwd?: string; argv?: string[] }) => {
    const c = commandOf(cmd, o);
    if (c === "git" || c.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", c)).stdout };
    killed.push(c);
    throw killedError(c, opts.hangStream ?? HUNG_STREAM, opts.treePid);
  };
  return { exec, killed };
}
