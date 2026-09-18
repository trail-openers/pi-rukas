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
 * Conflict: the batch aborts and the caller's VERIFIED restore
 * (#750, work-driver-restore.ts) unwinds every staged pick and proves the
 * root clean before the `cherry-pick-conflict` handoff. Tree-hash dedupe +
 * the recorded `commitShas` map keep resume / cross-workstream overlap
 * safe as before.
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
   * #728 (task-c) — set only when the range read errored and the pick fell
   * back to HEAD-only (never for a legitimately empty range); the
   * completeness-evidence consumer surfaces the range-fallback cause.
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
  /**
   * #749 — ADDITIVE discriminator for the baseSha path: workstreams whose
   * committed range existed but every pick was skipped as already-on-branch
   * (tree-hash dedup). `cherryApplied` semantics are UNCHANGED for the
   * existing baseSha callers (`runConsolidatedVerify`, `handoff-consolidate`) —
   * they keep reading it exactly as before. The integration layer reads THIS
   * field to tell "nothing was produced" apart from "work exists and its
   * content is already on the branch", instead of collapsing both into a
   * bare count.
   */
  skippedAlreadyOnBranch: string[];
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
   * of each committed workstream's cumulative `baseSha..worktree-HEAD` diff
   * (INTENDED) vs. the name-set that actually landed. `droppedPaths`
   * non-empty → `consolidation-incomplete` cap. Absent when no workstream
   * carried committed work. `checkError` = the read failed; NEVER read as
   * "complete".
   */
  completeness?: ConsolidationCompleteness;
}
/**
 * Cherry-pick each workstream's FULL committed range (parent→child) onto
 * the integration branch — #728: the pre-#728 pick used only the worktree's
 * HEAD SHA, so a ≥2-commit workstream (the #723 shape) staged the last
 * commit's files and silently dropped the earlier ones.
 * The batch is atomic: on the first conflict the in-progress abort is
 * attempted and `"conflict"` is returned explicitly (the pre-#750 `[]`
 * return collapsed "all skipped" with "conflict aborted" for a
 * single-workstream batch). No partial picks survive — the caller's
 * verified restore (#750) unwinds every staged pick and verifies the root.
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
): Promise<CherryPickEntry[] | "conflict"> {
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
  // If any cherry-pick conflicted, attempt the in-progress abort and return
  // the explicit conflict marker. #750: `git cherry-pick --no-commit` often
  // leaves no CHERRY_PICK_HEAD, in which case `--abort` REFUSES (exit 128)
  // — that refusal is neither success nor the only recovery, so it is
  // traced and the caller's verified restore (`verifiedRestoreRoot`) is the
  // actual recovery, verified by its own porcelain read.
  if (conflictedAt !== undefined) {
    try {
      await execFn("git cherry-pick --abort", { cwd: repoRoot, maxBuffer: 64 * 1024 });
    } catch (abortErr) {
      trace(
        `work-driver: cherry-pick — abort refused after conflict in '${conflictedAt}' (no CHERRY_PICK_HEAD for a --no-commit pick; caller restores): ${(abortErr as Error).message?.slice(0, 200)}`,
      );
    }
    return "conflict";
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
  // #749 — the all-skipped set, when the cherry-pick batch ran and every
  // pick was a tree-hash dedup skip (work existed; its content is already
  // on the branch).
  let allSkipped: string[] | undefined;
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
    const pick = await cherryPickWorkstreams(execFn, {
      repoRoot,
      branchName,
      worktrees: committedWorktrees,
      commitShas: preApplied,
      scratchDir,
      baseSha,
    });
    if (pick === "conflict") {
      // The batch aborted; every staged pick is unwound by the caller's
      // verified restore. #750: explicit marker — the caller restores the
      // branch and fails rather than shipping a partial batch.
      return {
        cherryApplied: [],
        cherryPickShas,
        skippedAlreadyOnBranch: [],
        patchApplied: [],
        noDiff: {},
        emptyWorkstreams,
        hadNewCommits: false,
        _conflict: "conflict",
      };
    }
    const entries = pick;
    if (entries.length === 0) {
      // Every pick was skipped as already on branch. #749: the skip is a
      // MEASURED fact, carried out of the cherry-pick layer as a
      // discriminator rather than collapsed into a bare count.
      const skipped: string[] = [];
      for (const id of ids) {
        if (cherryPickShas[id] && wtMap[id]) {
          cherryApplied.push(id);
          noDiff[id] = wtMap[id];
          skipped.push(id);
        }
      }
      if (skipped.length > 0) allSkipped = skipped;
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
            skippedAlreadyOnBranch: allSkipped ?? [],
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
          skippedAlreadyOnBranch: allSkipped ?? [],
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
    skippedAlreadyOnBranch: allSkipped ?? [],
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
