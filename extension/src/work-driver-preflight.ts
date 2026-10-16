/**
 * work-driver-preflight — the dirty-repoRoot preflight helpers extracted
 * from work-driver-integrate.ts (the file was at the 500-line cap).
 *
 * Both functions share the same filtering rule (the `integrate()` preflight
 * and the `restoreRepoRoot` caller both read porcelain through here, so the
 * two cannot drift): `.worktrees/` scaffolding is not dirt (driver's own
 * scaffolding, never staged), an untracked `??` entry under one of the project's
 * configured `.pi/dirty-root-exempt` prefixes is not dirt either (#1362), and
 * any other untracked `??` entry IS dirt (the N=1 pre-#287 shape develops
 * directly at repoRoot, and `stagePorcelainPaths` can sweep untracked files
 * into the PR — so an untracked-only root must refuse, not pass, and the
 * refusal parks rather than stash).
 *
 * WHO ENFORCES WHAT — the exemption has two different answers depending on the
 * question, and reading one where the other belongs is the trap:
 *
 *  - **Is it dirt?** (`isConfiguredExemptDirtLine`, prefix-matched) — the four
 *    dirty-root GATES: this file's `readDirtyPorcelain`, `integrate()`'s inline
 *    preflight, the branch step's `readRepoRootDirt`, and consolidated verify /
 *    integrate-worktree's own filters. A configured path is not dirt to any of
 *    them, whatever wrote it. That is the feature.
 *  - **Is it the cycle's work?** (`isClaimCountedEntry`, PROVENANCE-matched
 *    against `pipelineState.dirtyRootExemptBaseline`) — the restore CLAIM, and
 *    only the claim. A `??` file under an exempt prefix is spared there only
 *    when it already existed at cycle start; one the cycle wrote is named.
 *  - **Should it be stashed?** The abort path's stash pathspec is UNFILTERED
 *    (`cycleChangedPaths`), because an unstashed path is one the checkout can
 *    lose; a configured path is saved but never *restored* by a claim.
 *
 * #1362 deleted the third export this file used to hold,
 * `porcelainHasUntrackedOnly`: it had zero callers anywhere — not in `src/`, not
 * in a smoke test — and a filter no reader consults cannot keep its rule in
 * step with the two readers beside it.
 */
import { isConfiguredExemptDirtLine } from "./work-driver-dirty-root-exempt.ts";
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
  exempt?: readonly string[],
): Promise<string[] | undefined> {
  const { stdout } = await execFn("git status --porcelain", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  const dirt = stdout
    .split("\n")
    .filter(
      (l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l) && !isConfiguredExemptDirtLine(l, exempt),
    );
  return dirt.length > 0 ? dirt : undefined;
}

/**
 * #654 task-c — the shared restore convention for the repoRoot checkout.
 * Stash tracked dirt so a retry can integrate onto a clean tree, then pop it
 * back so the operator's work is never lost. Untracked-only dirt is not
 * safely stashable — the caller parks with the porcelain in evidence instead.
 *
 * #1362 — the untracked-only decision is exemption-aware, matching the gate
 * that produced `porcelain`: an untracked line under a configured exempt prefix
 * is neither dirt nor something this function saves or restores, so it must not
 * count toward "is there anything real here to stash?". A root whose only
 * non-scaffolding entries are exempt tool files parks with the "only untracked
 * files" reason rather than running a stash/pop over a tree that holds nothing
 * of the cycle's — the settlement's "a configured path is not saved or restored
 * by a claim", applied to the one stash this file performs. Without the
 * exemption an exempt `settings.local.json` beside a real tracked edit still
 * stashes (the tracked line decides), and one alone parks — the safe direction
 * either way.
 */
export async function restoreRepoRoot(
  execFn: ExecFn,
  repoRoot: string,
  porcelain: string[],
  exempt?: readonly string[],
): Promise<{ restored: boolean; reason?: string }> {
  // #750 — safety net, currently unreachable from production: the dirty-
  // preflight filters that feed this function (readDirtyPorcelain, integrate's
  // inline preflight) already exclude `??`, so a porcelain containing ONLY
  // untracked entries cannot reach the stash below. Kept deliberately:
  // stashing untracked work (`stash push -u`) risks dropping it, so a
  // future caller that passes untracked porcelain must park, not stash.
  if (
    !porcelain.some(
      (l) => l.trim().length > 0 && !l.startsWith("??") && !isConfiguredExemptDirtLine(l, exempt),
    )
  ) {
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
