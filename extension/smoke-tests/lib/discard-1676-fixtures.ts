/**
 * #1676 — the shared fixture for the two real-git discard tests.
 *
 * The discard pass is git work, so both files drive REAL git in scratch repos; a
 * fake exec would test nothing (the vacuous-fake class #1283). Both need the same
 * three things, and restating them in each file is how one drifts from the other:
 *
 *   - `gitEnv` — a commit identity and gpgsign off, so the host's config cannot
 *     make the driver's revert commit fail for a reason the test did not choose;
 *   - `realExec` — the argv-honouring executor the production seam uses, wired to
 *     that same env (an env-less fake would read the host `~/.gitconfig`);
 *   - `repoAtBase()` — the one repo shape every case starts from.
 *
 * Split out of test-discard-protected-1676.ts when the hardening/recovery cases
 * (test-discard-hardening-1676.ts) made the single file exceed the 500-line cap.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExecFn } from "../../src/work-develop-git.ts";
import { discardDeferred } from "../../src/work-driver-discard-deferred.ts";

/** The deferred gate file the plan fences, a source file, and a new-file path. */
export const FENCE = ".pi/verify-cmd";
export const SOURCE = "extension/src/b.ts";
export const NEW = ".github/workflows/new.yml";

/** Commit identity and signing are pinned so the host config cannot make the
 *  revert commit fail for a reason the test did not pick. */
export const gitEnv: Record<string, string> = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
} as Record<string, string>;

/** `git <args>` in `cwd` with the pinned env, stdout trimmed. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

const execAsync = promisify(execFile);

/** The argv-form executor, pinned to `gitEnv`. Production passes argv; a fake that
 *  ran `cmd` through a shell would exercise something other than what it claims. */
export const realExec = (async (_cmd: string, opts: { argv?: string[]; cwd: string }) => {
  const { stdout, stderr } = await execAsync("git", opts.argv ?? [], {
    cwd: opts.cwd,
    env: gitEnv,
  });
  return { stdout, stderr };
}) as unknown as ExecFn;

/** The discard pass as the develop step calls it; its results are appended to the
 *  caller's arrays and returned, so each case can read either. */
export async function discardDeferredProtectedEdits(a: {
  execFn: ExecFn;
  worktrees: Record<string, string>;
  baseFor: (id: string) => string | undefined;
  deferred: readonly string[];
  protectedGrant: readonly string[] | undefined;
  failures: string[];
  notes: string[];
}) {
  const r = await discardDeferred({
    execFn: a.execFn,
    worktrees: a.worktrees,
    baseFor: a.baseFor,
    deferred: a.deferred,
    grant: a.protectedGrant,
  });
  a.failures.push(...r.failures);
  a.notes.push(...r.notes);
  return r;
}

/** A scratch repo with the gate file and a source file, committed as the base. */
export function repoAtBase(prefix = "protected-discard-1676-"): { dir: string; base: string } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  git(dir, "init", "-q");
  mkdirSync(path.join(dir, ".pi"), { recursive: true });
  mkdirSync(path.join(dir, "extension/src"), { recursive: true });
  writeFileSync(path.join(dir, FENCE), "base-gate\n");
  writeFileSync(path.join(dir, SOURCE), "base-src\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

/** A tiny assert that reports and sets the caller's exit flag. */
export function makeAssert(onFail: () => void) {
  return (cond: boolean, msg: string): void => {
    if (cond) console.log(`✓ ${msg}`);
    else {
      console.error(`✗ ${msg}`);
      onFail();
    }
  };
}
