/**
 * work-driver-preflight — the dirty-repoRoot preflight helpers extracted
 * from work-driver-integrate.ts (the file was at the 500-line cap).
 *
 * Both functions share the same filtering rule (the `integrate()` preflight
 * and the `restoreRepoRoot` caller both read porcelain through here, so the
 * two cannot drift): `.worktrees/` scaffolding is not dirt (driver's own
 * scaffolding, never staged), and untracked `??` entries ARE dirt (the
 * N=1 pre-#287 shape develops directly at repoRoot, and `stagePorcelainPaths`
 * can sweep untracked files into the PR — so an untracked-only root must
 * refuse, not pass, and the refusal parks rather than stash).
 */
import type { ExecFn } from "./worktree.ts";

/**
 * #654 task-c — the dirty-repoRoot preflight as a reusable, single
 * implementation (the issue's "single implementation, not a copy").
 * Same filtering rule as `integrate()`'s inline preflight — `.worktrees/`
 * scaffolding is not dirt, and untracked `??` entries ARE dirt (see the
 * module header) — so the two cannot drift. Returns `undefined` when
 * repoRoot is clean (the common case).
 */
export async function readDirtyPorcelain(
  execFn: ExecFn,
  repoRoot: string,
): Promise<string[] | undefined> {
  const { stdout } = await execFn("git status --porcelain", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  const dirt = stdout.split("\n").filter((l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l));
  return dirt.length > 0 ? dirt : undefined;
}

/**
 * #654 task-c — the shared restore convention for the repoRoot checkout.
 * Stash tracked dirt so a retry can integrate onto a clean tree, then pop it
 * back so the operator's work is never lost. Untracked-only dirt is not
 * safely stashable — the caller parks with the porcelain in evidence instead.
 */
export async function restoreRepoRoot(
  execFn: ExecFn,
  repoRoot: string,
  porcelain: string[],
): Promise<{ restored: boolean; reason?: string }> {
  // #750 — safety net, currently unreachable from production: the dirty-
  // preflight filters that feed this function (readDirtyPorcelain, integrate's
  // inline preflight) already exclude `??`, so a porcelain containing ONLY
  // untracked entries cannot reach the stash below. Kept deliberately:
  // stashing untracked work (`stash push -u`) risks dropping it, so a
  // future caller that passes untracked porcelain must park, not stash.
  if (!porcelain.some((l) => l.trim().length > 0 && !l.startsWith("??"))) {
    return {
      restored: false,
      reason:
        "repo root has only untracked files — stashing is not safe for untracked work, so the cycle parks rather than risk dropping it",
    };
  }
  try {
    await execFn("git stash push -m pi-rukas-lens-fix-restore", {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
  } catch (err) {
    return {
      restored: false,
      reason: `git stash failed: ${(err as Error).message?.slice(0, 200)}`,
    };
  }
  try {
    await execFn("git stash pop", { cwd: repoRoot, maxBuffer: 256 * 1024 });
  } catch (err) {
    return {
      restored: false,
      reason: `git stash pop failed — the operator's work is in the stash (git stash list): ${(err as Error).message?.slice(0, 200)}`,
    };
  }
  return { restored: true };
}
