/**
 * work-driver-adversarial-fix-git — the git reads the adversarial fix pass
 * stands on (#1114). Every read returns a result, never a silent empty value:
 * a tree, base or HEAD that cannot be read is a park reason for the pass, not
 * "nothing changed". Split from work-driver-adversarial-fix.ts (AGENTS.md §12).
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { DriverContext } from "./work-driver-context.ts";

const execp = promisify(exec);
export type FixExec = NonNullable<DriverContext["verifyExecFn"]> | typeof execp;
/** The shell-string executor, used when the driver supplies no `verifyExecFn`. */
export const defaultExec: FixExec = execp;

export type GitRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** What a worktree holds relative to a commit: changed names, the diff, untracked files. */
export interface TreeChanges {
  names: string[];
  diff: string;
  untracked: string[];
}

const SHA_RE = /^[0-9a-f]{40}$/;

async function run(execFn: FixExec, cmd: string, cwd: string): Promise<GitRead<string>> {
  try {
    const { stdout } = await execFn(cmd, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, value: stdout };
  } catch (err) {
    const why = (err as Error).message?.slice(0, 200) ?? String(err);
    return { ok: false, reason: `\`${cmd}\` failed in ${cwd}: ${why}` };
  }
}

const lines = (s: string): string[] => s.split("\n").filter(Boolean);

/** The files tracked at the cycle's base commit. */
export async function trackedPaths(
  execFn: FixExec,
  repoRoot: string,
  baseSha: string | undefined,
): Promise<GitRead<string[]>> {
  if (!baseSha || !SHA_RE.test(baseSha)) {
    return { ok: false, reason: "no valid base SHA is recorded" };
  }
  const r = await run(execFn, `git ls-tree -r --name-only ${baseSha}`, repoRoot);
  return r.ok ? { ok: true, value: lines(r.value) } : r;
}

/** The commit a worktree's HEAD points at. */
export async function headOf(execFn: FixExec, cwd: string): Promise<GitRead<string>> {
  const r = await run(execFn, "git rev-parse HEAD", cwd);
  if (!r.ok) return r;
  const sha = r.value.trim();
  return SHA_RE.test(sha)
    ? { ok: true, value: sha }
    : { ok: false, reason: "HEAD is not a commit" };
}

/**
 * What a worktree holds relative to `sha`: committed and uncommitted changes
 * to tracked files, plus untracked files. Any failing read fails the whole.
 */
export async function treeChanges(
  execFn: FixExec,
  cwd: string,
  sha: string,
): Promise<GitRead<TreeChanges>> {
  if (!SHA_RE.test(sha)) return { ok: false, reason: "the comparison commit is not a SHA" };
  // --no-renames: a rename lists its source too, so a move from an out-of-fence
  // path onto a declared one cannot pass the fence by naming only the new side.
  const names = await run(execFn, `git diff --name-only --no-renames ${sha}`, cwd);
  if (!names.ok) return names;
  const diff = await run(execFn, `git diff ${sha}`, cwd);
  if (!diff.ok) return diff;
  const untracked = await run(execFn, "git ls-files --others --exclude-standard", cwd);
  if (!untracked.ok) return untracked;
  const extra = lines(untracked.value);
  return {
    ok: true,
    value: {
      names: [...new Set([...lines(names.value), ...extra])],
      diff: diff.value,
      untracked: extra,
    },
  };
}
