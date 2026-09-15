/**
 * work-driver-cherry-pick — cherry-pick developer commits onto the feature
 * branch during integration (#453; full-range pick + completeness #728).
 *
 * Each worktree is `--detach`ed at `baseSha`; the only way to reach a
 * developer's commits is by SHA, so integrate cherry-picks them onto the
 * integration branch in one atomic batch (replacing the pre-#453
 * `git apply --3way` transplant).
 *
 * #728: the pick walks each workstream's FULL `baseSha..HEAD` range
 * (parent→child), so a multi-commit worktree no longer stages only its
 * HEAD commit's files (the #723 strict-subset drop). After the batch,
 * `orchestrateCherryPick` runs the intended-vs-actual completeness check
 * (union of each worktree's cumulative diff vs. what landed) and reports
 * `droppedPaths` for the consumers' `consolidation-incomplete` cap.
 * Conflict: the batch aborts and the branch is restored (`cap-hit:
 * cherry-pick-conflict`). Tree-hash dedupe + the recorded `commitShas` map
 * keep resume / cross-workstream overlap safe as before.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { measureConsolidationCompleteness } from "./work-driver-completeness.ts";
import type { ConsolidationCompleteness } from "./work-driver-completeness.ts";
import type { NoDiff } from "./work-driver-integrate.ts";
import { rebaseStagedPatchOntoHead } from "./work-driver-rebase-patch.ts";
import { stagePorcelainPaths } from "./work-driver-stage.ts";
// #654 (task-b) — re-exported so existing importers keep their path.
export { rebaseStagedPatchOntoHead };
/** The worktree SHA + whether it was cherry-picked or skipped. */
interface CherryPickEntry {
  sha: string;
  /** `cherry-picked` when a new commit landed; `skipped` when already applied. */
  status: "cherry-picked" | "skipped";
  /**
   * #728 (task-c) — the workstream id of an entry picked via the HEAD-only
   * fallback after a `rev-list` range read failed. Recorded for the
   * completeness-evidence consumer that will surface the range-fallback
   * cause (follow-up: #728 task-d); not yet read by any gate in this
   * commit. Only set when the range read errored, never for a legitimately
   * empty range.
   */
  rangeReadError?: { workstreamId: string; error: string };
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
  /**
   * #728 (task-a) — intended-vs-actual completeness diagnostic: the union
   * of every committed workstream's cumulative
   * `git diff --name-only baseSha..worktree-HEAD` (the INTENDED stage set)
   * compared against the name-set that actually landed on the integration
   * branch (`baseSha..HEAD` there + the index). `droppedPaths` names what
   * did not land — a non-empty value is a hard failure the consumers route
   * to the `consolidation-incomplete` cap, distinct from
   * `cherry-pick-conflict` (the pick failed) and from a verify-command
   * failure (the code was fine; the diff was never assembled — the #723
   * incident). `intended` / `landed` carry both sides as executed evidence
   * (paths normalised via `normaliseDeclaredPath`). Absent only when no
   * workstream carried committed work. `checkError` is the honest third
   * state — the git read failed, the comparison could not run — and is
   * NEVER read as "complete".
   */
  completeness?: ConsolidationCompleteness;
}
/**
 * Cherry-pick each workstream's FULL committed range (parent→child) onto
 * the integration branch — #728: the pre-#728 pick used only the worktree's
 * HEAD SHA, so a ≥2-commit workstream (the #723 shape) staged the last
 * commit's files and silently dropped the earlier ones.
 * The batch is atomic: on the first conflict it aborts, the branch is
 * restored, and `[]` is returned. No partial cherry-picks survive.
 * #750 — the abort now handles the 128-refusal (no CHERRY_PICK_HEAD with
 * `--no-commit`) by falling back to `git reset --hard HEAD` instead of
 * swallowing the error.
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
    scratchDir?: string;
    /** Base the `baseSha..HEAD` range is measured against (usually the cycle baseSha). */
    baseSha?: string;
  },
): Promise<CherryPickEntry[]> {
  const { repoRoot, branchName, worktrees, commitShas, baseSha } = opts;
  const ids = Object.keys(worktrees);
  const entries: CherryPickEntry[] = [];
  const rangeFellBack = new Map<string, { workstreamId: string; error: string }>();
  let conflictedAt: string | undefined;
  // #728 — resolve each workstream's committed range (parent→child) once so
  // every SHA is deduplicated and picked in order; a range read failure
  // degrades to the legacy HEAD-only pick for that workstream (traced).
  const ranges: Record<string, string[]> = {};
  const rangeReadErrors = new Map<string, string>();
  for (const id of ids) {
    const wtPath = worktrees[id];
    if (!wtPath) continue;
    let list: string[] = [];
    if (baseSha) {
      try {
        const { stdout } = await execFn(
          `git rev-list --reverse --first-parent ${JSON.stringify(baseSha)}..HEAD`,
          { cwd: wtPath, maxBuffer: 1024 * 1024 },
        );
        list = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[0-9a-f]{7,}$/.test(l));
      } catch (err) {
        const msg = (err as Error).message?.slice(0, 200) ?? "unknown";
        rangeReadErrors.set(id, msg);
        trace(
          `work-driver: cherry-pick — could not list range for '${id}', falling back to HEAD only: ${msg}`,
        );
      }
    }
    if (list.length === 0) {
      const { stdout } = await execFn("git rev-parse HEAD", {
        cwd: wtPath,
        maxBuffer: 64 * 1024,
      });
      const sha = stdout.trim();
      if (sha && sha.length >= 7) list = [sha];
      // #728 (task-c) — a range-read failure degraded to the HEAD-only pick;
      // record it so the completeness evidence (task-a) can name the cause
      // instead of a bare dropped-path list.
      const rangeErr = rangeReadErrors.get(id);
      if (rangeErr) rangeFellBack.set(id, { workstreamId: id, error: rangeErr });
    }
    ranges[id] = list;
  }
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) continue;
    for (const sha of ranges[id] ?? []) {
      if (sha.length < 7) continue;
      // Check if this SHA is already on the integration branch.
      const alreadyOnBranch = await isCommitOnBranch(execFn, repoRoot, branchName, sha);
      if (alreadyOnBranch) {
        trace(
          `work-driver: cherry-pick — SHA ${sha.slice(0, 8)} for '${id}' already on branch, skipping`,
        );
        entries.push({ sha, status: "skipped", rangeReadError: rangeFellBack.get(id) });
        continue;
      }
      // Also skip if the SHA matches an already-recorded `commitShas` entry
      // for a DIFFERENT workstream (cross-workstream overlap).
      const recordSha = commitShas[id];
      if (recordSha && recordSha === sha) {
        trace(
          `work-driver: cherry-pick — SHA ${sha.slice(0, 8)} for '${id}' already recorded, skipping`,
        );
        entries.push({ sha, status: "skipped", rangeReadError: rangeFellBack.get(id) });
        continue;
      }
      // Cherry-pick the SHA.
      try {
        await execFn(`git cherry-pick --no-commit ${sha}`, {
          cwd: repoRoot,
          maxBuffer: 8 * 1024 * 1024,
        });
        entries.push({ sha, status: "cherry-picked", rangeReadError: rangeFellBack.get(id) });
      } catch {
        // Cherry-pick failed — this is a conflict. Abort the batch and record
        // which workstream caused it.
        conflictedAt = id;
        break;
      }
    }
  }
  // #750 — on conflict: attempt `git cherry-pick --abort`. With `--no-commit`
  // there is no CHERRY_PICK_HEAD, so git exits 128 (expected); fall back to
  // `git reset --hard HEAD` to clear the staged/unmerged index. The caller's
  // verifiedRestore confirms the root is clean. Returns [] on conflict.
  if (conflictedAt !== undefined) {
    try {
      await execFn("git cherry-pick --abort", { cwd: repoRoot, maxBuffer: 64 * 1024 });
      trace(`work-driver: cherry-pick — abort succeeded after conflict in '${conflictedAt}'`);
    } catch (abortErr) {
      const msg = (abortErr as Error).message?.slice(0, 200) ?? "";
      const isRefusal = /no cherry-pick or revert in progress|cherry-pick failed/i.test(msg);
      if (isRefusal) {
        trace(
          `work-driver: cherry-pick — abort refused (${msg}) — falling back to reset --hard HEAD`,
        );
        try {
          await execFn("git reset --hard HEAD", { cwd: repoRoot, maxBuffer: 256 * 1024 });
          trace("work-driver: cherry-pick — reset --hard HEAD fallback succeeded");
        } catch (resetErr) {
          trace(
            `work-driver: cherry-pick — reset --hard HEAD fallback FAILED: ${(resetErr as Error).message?.slice(0, 200)}`,
          );
        }
      } else {
        trace(
          `work-driver: cherry-pick — abort failed unexpectedly after conflict in '${conflictedAt}': ${msg}`,
        );
      }
    }
    return [];
  }
  return entries;
}
/**
 * Orchestrates the full cherry-pick integration for all workstreams.
 * Two-phase: first tries cherry-pick for worktrees with commits ahead of
 * baseSha; falls back to patch-transplant for worktrees without commits.
 * (Replaces the ~120-line block that lived in work-driver-integrate.ts.)
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
  // First pass: collect commit SHAs from worktrees with commits ahead.
  // #728 — the HEAD SHA is recorded here; the pick itself walks the full
  // baseSha..HEAD range inside cherryPickWorkstreams.
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
  // Cherry-pick the batch (only the workstreams with commits ahead); the
  // map is rebuilt so cherryPickWorkstreams only sees the committed ones.
  const committedWorktrees: Record<string, string> = {};
  for (const id of ids) {
    if (cherryPickShas[id] !== undefined && wtMap[id] !== undefined)
      committedWorktrees[id] = wtMap[id];
  }
  if (Object.keys(cherryPickShas).length > 0) {
    const entries = await cherryPickWorkstreams(execFn, {
      repoRoot,
      branchName,
      worktrees: committedWorktrees,
      commitShas: preApplied,
      scratchDir,
      baseSha,
    });
    if (entries.length === 0) {
      // Either all skipped (already on branch) or a conflict aborted.
      const cherryShasCount = Object.keys(cherryPickShas).length;
      const skippedCount = entries.filter((e) => e.status === "skipped").length;
      if (cherryShasCount === 0) {
        // No worktrees had commits — fall through to patch fallback.
      } else if (skippedCount < cherryShasCount) {
        // #750 — Conflict: the batch was aborted. The abort logic inside
        // cherryPickWorkstreams already attempted `git cherry-pick --abort`
        // and fell back to `git reset --hard HEAD` on a 128-refusal.
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
      // Cherry-picks succeeded — record each workstream that picked at
      // least one NEW commit exactly once (pre-#728 mis-indexed entries;
      // a 2-commit workstream appeared twice in cherryApplied).
      const seen = new Set<string>();
      for (const entry of entries) {
        if (entry.status !== "cherry-picked") continue;
        const id = Object.entries(cherryPickShas).find(
          ([candidate, sha]) => sha === entry.sha && !seen.has(candidate),
        )?.[0];
        if (id && !seen.has(id)) {
          seen.add(id);
          cherryApplied.push(id);
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
      let { stdout: patch } = await execFn("git diff --cached --binary", {
        cwd: wt,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (!patch.trim()) {
        noDiff[id] = wt;
        continue;
      }
      // #654 (task-b) — rebase the staged patch onto the branch's current head
      // before the apply, so a patch produced against a stale base no longer
      // conflicts. If the rebase cannot land, the original patch is kept and
      // the original apply path runs below, preserving the conflictPatch
      // convention for the cap evidence.
      const { stdout: headOut } = await execFn("git rev-parse HEAD", {
        cwd: repoRoot,
        maxBuffer: 64 * 1024,
      });
      const { stdout: wtHeadOut } = await execFn("git rev-parse HEAD", {
        cwd: wt,
        maxBuffer: 64 * 1024,
      });
      const branchHead = headOut.trim();
      const wtHead = wtHeadOut.trim();
      if (branchHead && branchHead !== wtHead) {
        const rebase = await rebaseStagedPatchOntoHead(execFn, {
          repoRoot,
          worktree: wt,
          targetSha: branchHead,
        });
        if (rebase.ok) {
          patch = rebase.patch;
          trace(
            `work-driver: cherry-pick — patch for '${id}' rebased onto branch head ${branchHead.slice(0, 8)}`,
          );
        } else {
          trace(
            `work-driver: cherry-pick — rebase of '${id}' patch onto ${branchHead.slice(0, 8)} failed: ${rebase.error.slice(0, 160)}`,
          );
        }
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
  // #728 (task-a) — intended-vs-actual completeness (see
  // measureConsolidationCompleteness); skipped when no workstream carried
  // committed work (nothing to compare).
  const committed = ids.filter((id) => cherryPickShas[id] !== undefined);
  const completeness =
    committed.length > 0
      ? await measureConsolidationCompleteness(execFn, {
          repoRoot,
          worktrees: wtMap,
          baseSha,
          committedIds: committed,
        })
      : undefined;
  const hadNewCommits = cherryApplied.length > 0 || patchApplied.length > 0;
  return {
    cherryApplied,
    cherryPickShas,
    patchApplied,
    noDiff,
    emptyWorkstreams,
    hadNewCommits,
    completeness,
  };
}
/**
 * Check if a commit is already reachable from the integration branch.
 * Uses tree-hash comparison: identical trees = the commit is effectively
 * already applied (even if the SHA differs, e.g. from a resume). Returns
 * `false` on any read error (optimistic: cherry-pick if we can't verify).
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
