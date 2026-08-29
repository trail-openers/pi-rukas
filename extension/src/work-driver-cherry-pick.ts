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

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { NoDiff } from "./work-driver-integrate.ts";
import { stagePorcelainPaths } from "./work-driver-stage.ts";

/** The worktree SHA + whether it was cherry-picked or skipped. */
interface CherryPickEntry {
  sha: string;
  /** `cherry-picked` when a new commit landed; `skipped` when already applied. */
  status: "cherry-picked" | "skipped";
}

/** Workstream ids ordered by the caller's iteration. */
interface WorkstreamList {
  /** Ordered workstream ids (matches worktrees keys in the same order). */
  ids: string[];
  /** Workstream id → worktree path. */
  worktrees: Record<string, string>;
  /** SHA already applied from a previous attempt; keyed by workstream id. */
  commitShas: Record<string, string>;
}

/** Return value of `orchestrateCherryPick`. Discriminated union for error cases. */
export interface OrchestratedCherryPickResult {
  /** CHERRY-PICK: which workstreams got new commits (cherry-picked or already-on-branch). */
  cherryApplied: string[];
  /** CHERRY-PICK: which workstreams had commits ahead of baseSha, keyed by id → SHA. */
  cherryPickShas: Record<string, string>;
  /** PATCH: which workstreams had no commits but had patchable changes. */
  patchApplied: string[];
  /** Which workstreams produced no diff at all, keyed by id → worktree path. */
  noDiff: NoDiff;
  /** Which workstreams had no commits ahead of baseSha (patch-fallback candidates). */
  emptyWorkstreams: string[];
  /** Whether ANY cherry-pick resulted in a new commit (not all were skipped). */
  hadNewCommits: boolean;
  /** Error discriminator: cherry-pick batch conflicted and was aborted. */
  _conflict?: "conflict";
  /** Error discriminator: requireAllNonEmpty failed for this workstream id. */
  _noDiffRequireFail?: string;
  /** Error discriminator: git apply failed during patch fallback. */
  _applyConflict?: { id: string; reason: string; patchFile: string };
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
 * Orchestrates the full cherry-pick integration for all workstreams.
 *
 * Two-phase: first tries cherry-pick for worktrees with commits ahead of
 * baseSha; falls back to patch-transplant for worktrees without commits.
 *
 * This replaces the ~120-line orchestration block that used to live in
 * `work-driver-integrate.ts`, keeping that file under the 500-line cap.
 */
export async function orchestrateCherryPick(
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
  opts: {
    repoRoot: string;
    branchName: string;
    worktrees: WorkstreamList;
    baseSha?: string;
    scratchDir: string;
    requireAllNonEmpty?: boolean;
  },
): Promise<OrchestratedCherryPickResult> {
  const { repoRoot, branchName, baseSha, worktrees, scratchDir, requireAllNonEmpty } = opts;
  const { ids, worktrees: wtMap, commitShas: preApplied } = worktrees;
  const cherryPickShas: Record<string, string> = {};
  const cherryApplied: string[] = [];
  const noDiff: NoDiff = {};
  const emptyWorkstreams: string[] = [];
  const patchApplied: string[] = [];

  // First pass: collect commit SHAs from worktrees that have commits ahead.
  if (baseSha) {
    for (const id of ids) {
      const wt = wtMap[id];
      if (!wt) continue;
      try {
        const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(baseSha)}..HEAD`, {
          cwd: wt,
          maxBuffer: 64 * 1024,
        });
        const ahead = Number.parseInt(stdout.trim(), 10);
        if (Number.isFinite(ahead) && ahead > 0) {
          const { stdout: shaOut } = await execFn("git rev-parse HEAD", {
            cwd: wt,
            maxBuffer: 64 * 1024,
          });
          const sha = shaOut.trim();
          if (sha) {
            cherryPickShas[id] = sha;
            continue;
          }
        }
      } catch {
        // Worktree might not have baseSha in history — treat as empty.
      }
      emptyWorkstreams.push(id);
    }
  } else {
    // No baseSha — mark all as empty (patch fallback).
    for (const id of ids) {
      if (wtMap[id]) emptyWorkstreams.push(id);
    }
  }

  // Cherry-pick the batch.
  if (Object.keys(cherryPickShas).length > 0) {
    const entries = await cherryPickWorkstreams(execFn, {
      repoRoot,
      branchName,
      worktrees: (() => {
        const result: Record<string, string> = {};
        for (const id of ids) {
          if (cherryPickShas[id] !== undefined && wtMap[id] !== undefined) {
            result[id] = wtMap[id];
          }
        }
        return result;
      })(),
      commitShas: preApplied,
      scratchDir,
    });

    if (entries.length === 0) {
      // Either all skipped (already on branch) or a conflict aborted.
      const cherryShasCount = Object.keys(cherryPickShas).length;
      const skippedCount = entries.filter((e) => e.status === "skipped").length;
      if (cherryShasCount === 0) {
        // No worktrees had commits — fall through to patch fallback.
      } else if (skippedCount < cherryShasCount) {
        // Conflict: the batch was aborted. Signal caller via empty result + flag.
        // Caller must restore branch and fail.
        return {
          cherryApplied: [],
          cherryPickShas,
          patchApplied: [],
          noDiff: {},
          emptyWorkstreams,
          hadNewCommits: false,
          _conflict: "conflict",
        };
      }
      // All skipped (already on branch) — treat as applied but no new commit.
      for (const id of ids) {
        if (cherryPickShas[id] && wtMap[id]) {
          cherryApplied.push(id);
          noDiff[id] = wtMap[id];
        }
      }
    } else {
      // Cherry-picks succeeded — record SHAs.
      const entryShaToId = new Map<string, string>();
      for (const [id, wt] of Object.entries(wtMap)) {
        if (cherryPickShas[id]) entryShaToId.set(wt, id);
      }
      for (const entry of entries) {
        if (entry.status === "cherry-picked") {
          for (const [id] of Object.entries(wtMap)) {
            if (cherryPickShas[id]) {
              cherryApplied.push(id);
              break;
            }
          }
        }
      }
    }
  }

  // Fallback: patch-transplant for worktrees without commits.
  if (emptyWorkstreams.length > 0) {
    for (const id of emptyWorkstreams) {
      const wt = wtMap[id];
      if (!wt) continue;
      const staged = await stagePorcelainPaths(execFn, wt);
      if (staged === 0) {
        noDiff[id] = wt;
        if (requireAllNonEmpty) {
          return {
            cherryApplied,
            cherryPickShas,
            patchApplied,
            noDiff: { ...noDiff, [id]: wt },
            emptyWorkstreams,
            hadNewCommits: cherryApplied.length > 0,
            _noDiffRequireFail: id,
          };
        }
        continue;
      }
      const { stdout: patch } = await execFn("git diff --cached --binary", {
        cwd: wt,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (!patch.trim()) {
        noDiff[id] = wt;
        continue;
      }
      const patchFile = path.join(scratchDir, `integrate-${id}.patch`);
      await fs.mkdir(path.dirname(patchFile), { recursive: true });
      await fs.writeFile(patchFile, patch, "utf8");
      try {
        await execFn(`git apply --3way --binary ${JSON.stringify(patchFile)}`, {
          cwd: repoRoot,
          maxBuffer: 1024 * 1024,
        });
        patchApplied.push(id);
      } catch (err) {
        const e = err as Error & { stderr?: string };
        return {
          cherryApplied,
          cherryPickShas,
          patchApplied,
          noDiff,
          emptyWorkstreams,
          hadNewCommits: cherryApplied.length > 0,
          _applyConflict: {
            id,
            reason: (e.stderr ?? e.message ?? "").toString().trim().slice(0, 200),
            patchFile,
          },
        };
      }
    }
  }

  const hadNewCommits = cherryApplied.length > 0 || patchApplied.length > 0;

  return {
    cherryApplied,
    cherryPickShas,
    patchApplied,
    noDiff,
    emptyWorkstreams,
    hadNewCommits,
  };
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
