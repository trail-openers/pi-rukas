/**
 * work-driver-cherry-pick — cherry-pick developer commits onto the feature
 * branch during integration (#453).
 *
 * Under always-worktree, each workstream develops in a `--detach`ed worktree
 * at `baseSha`. The developer commits there; integrate cherry-picks those
 * commits onto the integration branch in one atomic batch.
 *
 * This replaces the pre-#453 patch-transplant (`git apply --3way`) with
 * commit-sha cherry-pick, which is the correct transfer unit under
 * worktree isolation because the only way to reach a developer's commits is
 * by SHA — the worktree has no branch name.
 *
 * Conflict path: on the first cherry-pick that conflicts, the batch aborts,
 * the integration branch is restored to its pre-batch state, and the cycle
 * halts with `cap-hit: cherry-pick-conflict`. The operator inspects the
 * conflict in the PR branch and resolves it manually.
 *
 * Empty/already-applied: before cherry-picking a SHA, the function checks
 * if the commit's tree hash is already reachable from the integration
 * branch. If so, the SHA is skipped silently (not counted as applied) — a
 * cherry-pick that would do nothing is dropped, not recorded as a
 * successful operation.
 *
 * Resume safety: the caller (mechanizedCommitPr) passes `commitShas`
 * populated from a previous attempt. The function reads each workstream's
 * HEAD, skips commits already applied (tree-hash match), and records every
 * SHA it acted on (cherry-picked or skipped) so a resumed cycle knows
 * what was done.
 */

import { trace } from "./trace.ts";

/** The worktree SHA + whether it was cherry-picked or skipped. */
interface CherryPickEntry {
  sha: string;
  /** `cherry-picked` when a new commit landed; `skipped` when already applied. */
  status: "cherry-picked" | "skipped";
}

/**
 * Cherry-pick each workstream's HEAD commit onto the integration branch.
 *
 * @param execFn — shell executor (injectable for testing).
 * @param opts — integration branch, worktrees, and pre-existing commit SHAs.
 * @returns list of entries with SHA and status.
 *
 * The batch is atomic: on the first conflict, the batch aborts, the branch
 * is restored, and `[]` is returned. No partial cherry-picks survive.
 */
export async function cherryPickWorkstreams(
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
  opts: {
    repoRoot: string;
    branchName: string;
    /** Workstream id → worktree path. Only workstreams listed here are cherry-picked. */
    worktrees: Record<string, string>;
    /** SHA already applied from a previous attempt; keyed by workstream id. */
    commitShas: Record<string, string>;
    /** Scratch dir for conflict artifacts. */
    scratchDir: string;
  },
): Promise<CherryPickEntry[]> {
  const { repoRoot, branchName, worktrees, commitShas, scratchDir } = opts;
  const ids = Object.keys(worktrees);
  const entries: CherryPickEntry[] = [];
  let conflictedAt: string | undefined;

  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) continue;

    // Read the developer's commit SHA from the worktree.
    const { stdout: shaOut } = await execFn("git rev-parse HEAD", {
      cwd: wt,
      maxBuffer: 64 * 1024,
    });
    const sha = shaOut.trim();
    if (!sha || sha.length < 7) {
      trace(
        `work-driver: cherry-pick — workstream '${id}' has no commit (SHA: "${sha}"), skipping`,
      );
      continue;
    }

    // Check if this SHA is already on the integration branch.
    const alreadyOnBranch = await isCommitOnBranch(execFn, repoRoot, branchName, sha);
    if (alreadyOnBranch) {
      trace(
        `work-driver: cherry-pick — SHA ${sha.slice(0, 8)} for '${id}' already on branch, skipping`,
      );
      entries.push({ sha, status: "skipped" });
      continue;
    }

    // Also skip if the SHA matches an already-recorded `commitShas` entry
    // for a DIFFERENT workstream (cross-workstream overlap).
    const recordSha = commitShas[id];
    if (recordSha && recordSha === sha) {
      trace(
        `work-driver: cherry-pick — SHA ${sha.slice(0, 8)} for '${id}' already recorded, skipping`,
      );
      entries.push({ sha, status: "skipped" });
      continue;
    }

    // Cherry-pick the SHA.
    try {
      await execFn(`git cherry-pick --no-commit ${sha}`, {
        cwd: repoRoot,
        maxBuffer: 8 * 1024 * 1024,
      });
      entries.push({ sha, status: "cherry-picked" });
    } catch (err) {
      // Cherry-pick failed — this is a conflict. Abort the batch and record
      // which workstream caused it.
      conflictedAt = id;
      break;
    }
  }

  // If any cherry-pick conflicted, abort the batch.
  if (conflictedAt !== undefined) {
    try {
      await execFn("git cherry-pick --abort", {
        cwd: repoRoot,
        maxBuffer: 64 * 1024,
      });
    } catch (abortErr) {
      trace(
        `work-driver: cherry-pick — abort failed after conflict in '${conflictedAt}': ${(abortErr as Error).message?.slice(0, 200)}`,
      );
    }
    // Return empty: the caller will restore the branch and halt the cycle.
    return [];
  }

  return entries;
}

/**
 * Check if a commit is already reachable from the integration branch.
 *
 * Uses tree-hash comparison: read the commit's tree, compare with the tree
 * of HEAD on the branch. Identical trees = the commit is effectively
 * already applied (even if the commit SHA differs, e.g. from a resume).
 *
 * Returns `true` if the commit is already on the branch, `false` otherwise.
 * Returns `false` on any read error (optimistic: assume it needs to be
 * cherry-picked if we can't verify).
 */
async function isCommitOnBranch(
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
  repoRoot: string,
  branchName: string,
  sha: string,
): Promise<boolean> {
  try {
    const { stdout: commitTree } = await execFn(`git cat-file -p ${sha}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const m = commitTree.match(/^tree ([0-9a-f]{40})$/m);
    if (!m) return false;
    const commitTreeHash = m[1];

    const { stdout: headTree } = await execFn("git cat-file -p HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const headMatch = headTree.match(/^tree ([0-9a-f]{40})$/m);
    if (!headMatch) return false;

    return commitTreeHash === headMatch[1];
  } catch {
    // Can't verify — assume the commit needs to be applied.
    return false;
  }
}
