/**
 * work-driver-rebase-patch — #654 (task-b): rebase a worktree's staged patch
 * onto the branch's current head so a lens-fix patch produced against a
 * stale base no longer conflicts.
 *
 * Commits the staged work on a scratch branch, rebases onto `targetSha`,
 * extracts the rebased diff, and restores the worktree to its original
 * detached HEAD. Failure returns `{ ok: false, error }`; the caller
 * (orchestrateCherryPick's patch fallback) falls through to the original
 * apply path, preserving the `conflictPatch` convention for the cap
 * evidence. Split from work-driver-cherry-pick.ts (AGENTS.md §12).
 */

import { stagePorcelainPaths } from "./work-driver-stage.ts";

/**
 * Rebase the worktree's staged patch onto `targetSha` (the branch's current
 * head). See the module header for the full contract.
 */
export async function rebaseStagedPatchOntoHead(
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
  opts: { repoRoot: string; worktree: string; targetSha: string },
): Promise<{ ok: true; patch: string } | { ok: false; error: string }> {
  const { worktree, targetSha } = opts;
  const scratchName = `__pi-rukas-rebase-${Date.now().toString(36)}`;
  try {
    const { stdout: origHead } = await execFn("git rev-parse HEAD", {
      cwd: worktree,
      maxBuffer: 64 * 1024,
    });
    const orig = origHead.trim();
    const staged = await stagePorcelainPaths(execFn, worktree);
    if (staged === 0) return { ok: false, error: "worktree had no stageable changes" };
    await execFn(`git checkout -B ${JSON.stringify(scratchName)}`, {
      cwd: worktree,
      maxBuffer: 64 * 1024,
    });
    await execFn(`git commit -q -m "${JSON.stringify("pi-rukas rebase scratch")}"`, {
      cwd: worktree,
      maxBuffer: 256 * 1024,
    });
    await execFn(
      `git rebase --onto ${JSON.stringify(targetSha)} ${JSON.stringify(`${orig}..HEAD`)}`,
      { cwd: worktree, maxBuffer: 8 * 1024 * 1024 },
    );
    const { stdout: patchOut } = await execFn("git diff HEAD~1..HEAD --binary", {
      cwd: worktree,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!patchOut.trim()) return { ok: false, error: "rebase produced an empty patch" };
    await execFn(`git checkout --detach ${JSON.stringify(orig)}`, {
      cwd: worktree,
      maxBuffer: 64 * 1024,
    });
    await execFn(`git branch -D ${JSON.stringify(scratchName)}`, {
      cwd: worktree,
      maxBuffer: 64 * 1024,
    }).catch(() => undefined);
    return { ok: true, patch: patchOut };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const detail = (e.stderr ?? e.message ?? "").toString().trim().slice(0, 200);
    await execFn("git rebase --abort", { cwd: worktree, maxBuffer: 64 * 1024 }).catch(
      () => undefined,
    );
    await execFn(`git checkout --detach ${JSON.stringify("HEAD")}`, {
      cwd: worktree,
      maxBuffer: 64 * 1024,
    }).catch(() => undefined);
    return { ok: false, error: detail || "rebase failed" };
  }
}
