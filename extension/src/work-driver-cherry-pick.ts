/**
 * work-driver-cherry-pick — cherry-pick developer commits onto the feature
 * branch during integration (#453; full-range pick + completeness #728).
 *
 * Each worktree is `--detach`ed at `baseSha`; integrate cherry-picks the
 * commits on the integration branch in one atomic batch. #728: the pick
 * walks each workstream's committed range (parent→child); #794: a stacked
 * workstream's range is its OWN range — its commits against its dependency's
 * tip (`workstreamBaseShas`), never the global base — so ancestor commits
 * are not re-picked on top of their content (the #775 replay). On conflict
 * the batch aborts and the caller's VERIFIED restore (#750) unwinds every
 * staged pick; tree-hash dedupe + the recorded `commitShas` map keep resume
 * / cross-workstream overlap safe.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { CherryPickConflict } from "./work-driver-cherry-pick-conflict.ts";
import { measureConsolidationCompleteness } from "./work-driver-completeness.ts";
import type { ConsolidationCompleteness } from "./work-driver-completeness.ts";
import { isCommitOnBranch } from "./work-driver-integrate-commit.ts";
import type { NoDiff } from "./work-driver-integrate.ts";
import { rebaseStagedPatchOntoHead } from "./work-driver-rebase-patch.ts";
import { stagePorcelainPaths } from "./work-driver-stage.ts";
// #654 (task-b) — re-exported so existing importers keep their path.
export { rebaseStagedPatchOntoHead };
// #794 (task-b) — re-exported from its own module (AGENTS.md §12 file-size
// limit) so importers keep this path.
export { dependencyLeaves } from "./work-driver-leaf-selection.ts";

// #794 — per-workstream OWN range (see module header).
export type WorkStreamPickScope = {
  globalBaseSha?: string;
  workstreamBaseShas?: Record<string, string>;
};

export function pickScopeBase(id: string, scope: WorkStreamPickScope): string | undefined {
  const per = scope.workstreamBaseShas?.[id];
  if (per && /^[0-9a-f]{40}$/.test(per)) return per;
  return scope.globalBaseSha;
}

/** The worktree SHA + whether it was cherry-picked or skipped. */
export interface CherryPickEntry {
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
export interface WorkstreamList {
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
  /**
   * #813 — the OBSERVATION behind a conflicted batch: which pick failed,
   * and what applied cleanly before it. Shape + rationale in
   * `CherryPickConflict` (work-driver-cherry-pick-conflict.ts). The
   * consolidated-verify reporters read these to describe the failure rather
   * than infer "two workstreams edited the same lines; the decomposition is
   * incoherent". Absent = the read failed; absence is reported as absence.
   */
  _conflictedWorkstream?: CherryPickConflict["conflictedAt"];
  _conflictAppliedBefore?: CherryPickConflict["appliedBeforeConflict"];
  /** #813 — the file git named for the aborted pick (see `CherryPickConflict`). */
  _conflictedFile?: CherryPickConflict["conflictedFile"];
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
// #813 — split to their own modules (AGENTS.md §12 file-size limit);
// re-exported so importers keep this path.
import { cherryPickWorkstreams } from "./work-driver-cherry-pick-batch.ts";
export { cherryPickWorkstreams } from "./work-driver-cherry-pick-batch.ts";
export type { CherryPickConflict } from "./work-driver-cherry-pick-conflict.ts";

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
    /**
     * #794 — per-workstream own-range selection (see `WorkStreamPickScope`).
     * Absent → legacy single-`baseSha` range, byte-identical to pre-#794.
     */
    pickScope?: WorkStreamPickScope;
  },
): Promise<OrchestratedCherryPickResult> {
  const { repoRoot, branchName, worktrees, scratchDir, requireAllNonEmpty } = opts;
  const scope: WorkStreamPickScope = opts.pickScope ?? { globalBaseSha: opts.baseSha };
  const baseSha = scope.globalBaseSha;
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
        // #794 — count OWN commits (against the workstream's effective base)
        // so a dependent with nothing of its own is not miscounted as
        // carrying the ancestors' commits.
        const rangeBase = pickScopeBase(id, scope);
        const { stdout } = await execFn(
          `git rev-list --count ${JSON.stringify(rangeBase ?? baseSha)}..HEAD`,
          { cwd: wt, maxBuffer: 64 * 1024 },
        );
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
      pickScope: scope,
    });
    if ("__conflict" in pick) {
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
        _conflictedWorkstream: pick.conflictedAt,
        _conflictAppliedBefore: pick.appliedBeforeConflict,
        ...(pick.conflictedFile !== undefined ? { _conflictedFile: pick.conflictedFile } : {}),
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
          pickScope: scope,
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
// isCommitOnBranch (the tree-hash dedup check) moved to
// work-driver-integrate.ts to keep this file under the 500-line gate.
