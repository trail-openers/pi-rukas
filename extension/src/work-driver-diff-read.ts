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

import { realpathSync } from "node:fs";
import { execp } from "./exec.ts";
import { errorText, execGit } from "./git-range.ts";
import { FULL_SHA } from "./work-driver-diff.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Resolve a path for the toplevel comparison. An unresolvable path is NOT a
 * near-miss to wave through: this read gates an approval, and a directory that
 * the kernel cannot name is a directory whose diff nobody can vouch for.
 */
function realpathOrError(
  p: string,
  cwd: string,
  what: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  try {
    return { ok: true, path: realpathSync(p) };
  } catch (err) {
    return {
      ok: false,
      reason: `cannot resolve ${what} ${p} (read from ${cwd}): ${errorText(err)}`,
    };
  }
}

/** The 1 MiB cap `fetchDiff` uses; a runaway worktree must not bloat the prompt. */
const DIFF_MAX_BUFFER = 1024 * 1024;

/**
 * A path safe to interpolate into a git argv. Absolute, printable, no shell
 * metacharacters, and — unlike a bare character class that keeps `-` first — no
 * leading `-` either: git reads an argument beginning with `-` as an option, and
 * this value reaches it as `cwd`. A rejected path is a `{ ok: false }` read, so
 * the strictness costs an approval at worst and never a surprise option.
 */
const SAFE_CWD = /^\/[A-Za-z0-9._/~:][A-Za-z0-9._~/:-]*$/;

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
  // #1634 — compare the DIRECTORIES, not the two strings. A raw comparison made
  // a worktree whose path arrives through a symlink, with a trailing slash, or
  // as `..`/`.`-padded reject itself: the read was sound, and the gate parked on
  // "not its own worktree root" for a tree that was. `realpathSync` resolves both
  // sides to the same kernel answer, so the check means what it says.
  //
  // It fails CLOSED: either path unresolvable is a failed read, not a pass.
  // A worktree that cannot be resolved is precisely the case this gate exists for
  // — the driver does not know what it would be comparing.
  const resolvedToplevel = realpathOrError(toplevel, cwd, "git-reported worktree root");
  if (!resolvedToplevel.ok) return { ok: false, reason: resolvedToplevel.reason };
  const resolvedCwd = realpathOrError(cwd, cwd, "worktree path");
  if (!resolvedCwd.ok) return { ok: false, reason: resolvedCwd.reason };
  if (resolvedToplevel.path !== resolvedCwd.path) {
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
  //
  // #1634 — the base is pinned by FULL_SHA, the SAME 40-hex gate `fetchDiff`
  // applies (one predicate, imported, not a second pattern that can drift). The
  // loose ref shape this used to test admitted a leading `-`, which git reads
  // as an OPTION even after `--end-of-options`, and a value that resolves to a
  // ref instead of a commit. A diff read that gates an approval pins the
  // comparison to a full object id or compares nothing.
  const pinned = baseSha !== undefined && FULL_SHA.test(baseSha);
  if (pinned) {
    const rangeArgs = ["diff", "--end-of-options", `${baseSha}..HEAD`];
    let committed: string;
    try {
      committed = await execGit(exec, cwd, rangeArgs, { maxBuffer: DIFF_MAX_BUFFER });
    } catch (err) {
      return unreadable(rangeArgs, err);
    }
    if (committed.trim()) return { ok: true, diff: committed };
  }
  const range = pinned ? `${baseSha}..HEAD` : "HEAD";
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
