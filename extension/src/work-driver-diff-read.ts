/**
 * work-driver-diff-read — #1634: the worktree diff read that can say
 * "I could not tell".
 *
 * `fetchDiff` returns `""` for every failure — no cwd, a directory that is
 * not a repository, a `git diff` that throws or exits non-zero — and the
 * adversarial gate reads `""` as a clean tree: `adversarial-skipped-empty-diff`
 * plus `adversarial-approved {rounds: 0}`. A killed develop round whose tree
 * nobody could read was therefore "approved" and merged. That is the same
 * defect #384 removed from the lens path (`readIntegratedDiff` returning a
 * discriminated result, empty established POSITIVELY), reproduced on the
 * pre-commit read the gate actually uses.
 *
 * Split from work-driver-diff.ts, which was already at the §12 size cap and
 * whose callers that do NOT gate an approval keep the old best-effort shape.
 */

import { execp } from "./exec.ts";
import { errorText, execGit } from "./git-range.ts";
import type { ExecFn } from "./worktree.ts";

/** The 1 MiB cap `fetchDiff` uses; a runaway worktree must not bloat the prompt. */
const DIFF_MAX_BUFFER = 1024 * 1024;

/** A path safe to interpolate into a git argv. Absolute, printable, no shell metacharacters. */
const SAFE_CWD = /^\/[A-Za-z0-9._/~-]*$/;

/** A ref or ref range safe to interpolate into a git argv. */
const SAFE_RANGE = /^[A-Za-z0-9._^{}~/:@-]+$/;

export type WorktreeDiff = { ok: true; diff: string } | { ok: false; reason: string };

/**
 * Read a worktree's diff for the adversarial gate, distinguishing "nothing to
 * review" from "could not find out".
 *
 * `empty` is established POSITIVELY: the toplevel read named a repository and
 * `git diff` exited 0 producing nothing. Anything else — no cwd, a directory
 * that is not a repository, a read that threw, hung or overflowed its buffer —
 * is `{ ok: false }`, and the caller must treat that as no evidence rather
 * than as approval.
 *
 * `execFn` is the driver's exec seam (the same one `verifyExecFn` injects), so
 * a test fake answers both reads; production defaults to `execp`. Every call
 * goes through `execGit`: argv always, a bounded timeout always, never a
 * command string.
 */
export async function readWorktreeDiff(
  cwd: string | undefined,
  baseSha?: string,
  execFn?: ExecFn,
): Promise<WorktreeDiff> {
  const exec = execFn ?? execp;
  if (!cwd) return { ok: false, reason: "no worktree path was recorded for this workstream" };
  if (!SAFE_CWD.test(cwd)) return { ok: false, reason: `worktree path ${cwd} is not usable` };
  // The read only means something about the directory it names. Without this
  // probe a plain directory under a repo would resolve git's PARENT repository
  // and its clean tree would read as "this workstream changed nothing".
  let toplevel: string;
  try {
    toplevel = (
      await execGit(exec, cwd, ["rev-parse", "--show-toplevel"], { maxBuffer: 64 * 1024 })
    ).trim();
  } catch (err) {
    return {
      ok: false,
      reason: `git rev-parse --show-toplevel failed in ${cwd}: ${errorText(err)}`,
    };
  }
  if (!toplevel) {
    return { ok: false, reason: `git reported no worktree root for ${cwd} (empty output)` };
  }
  if (toplevel !== cwd.replace(/\/+$/, "")) {
    return {
      ok: false,
      reason: `${cwd} is not its own worktree root — git reported ${toplevel}`,
    };
  }
  const unreadable = (args: string[], err: unknown): WorktreeDiff => ({
    ok: false,
    reason: `git ${args.join(" ")} failed in ${cwd}: ${errorText(err)}`,
  });
  // Committed work first (post-#453: after a developer commit `git diff HEAD`
  // is empty because HEAD IS the commit), then the uncommitted fallback.
  if (baseSha && SAFE_RANGE.test(baseSha)) {
    const rangeArgs = ["diff", "--end-of-options", `${baseSha}..HEAD`];
    let committed: string;
    try {
      committed = await execGit(exec, cwd, rangeArgs, { maxBuffer: DIFF_MAX_BUFFER });
    } catch (err) {
      return unreadable(rangeArgs, err);
    }
    if (committed.trim()) return { ok: true, diff: committed };
  }
  const range = baseSha && SAFE_RANGE.test(baseSha) ? `${baseSha}..HEAD` : "HEAD";
  const fallbackArgs = ["diff", "--end-of-options", range];
  try {
    return {
      ok: true,
      diff: await execGit(exec, cwd, fallbackArgs, { maxBuffer: DIFF_MAX_BUFFER }),
    };
  } catch (err) {
    return unreadable(fallbackArgs, err);
  }
}
