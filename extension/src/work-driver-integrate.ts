/** #287 Part B — the ONLY path that writes to repoRoot. */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { orchestrateCherryPick } from "./work-driver-cherry-pick.ts";
import type { ConsolidationCompleteness } from "./work-driver-completeness.ts";
import { runCommitPrConsolidatedVerify } from "./work-driver-integrate-verify.ts";
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";
import type { WorkState } from "./workflow-state-schema.ts";
import type { ExecFn } from "./worktree.ts";
import { sweepBranchHolders } from "./worktree.ts";
// Re-exported for backward compatibility (callers imported these from
// work-driver-integrate.ts pre-#750; the implementations now live in
// work-driver-preflight.ts).
export { readDirtyPorcelain, restoreRepoRoot } from "./work-driver-preflight.ts";

// #794 — the integration lock lives in work-driver-lock.ts (extracted to
// keep this file under the 500-line gate); the re-exports below preserve
// every existing import path unchanged.
export { withIntegrationLock, __resetIntegrationLock } from "./work-driver-lock.ts";

/** Issue title from the explore step's cached artifact; undefined on miss. */
export async function cachedIssueTitle(state: WorkState): Promise<string | undefined> {
  const artifact = state.pipelineState.issueBodyArtifact;
  if (!artifact) return undefined;
  try {
    const body = await fs.readFile(artifact, "utf8");
    return body.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export interface IntegrateOpts {
  repoRoot: string;
  branchName: string;
  /** Commit-ish the branch is created at. Required for mode "create". */
  baseSha?: string;
  worktrees: Record<string, string>;
  /**
   * #794 — per-workstream effective base map (`pipelineState.workstreamBaseShas`).
   * A stacked workstream's OWN range is measured against its dependency's tip
   * instead of the global baseSha, so its ancestor commits are not re-picked
   * on top of their content (the #775 replay). A workstream with no entry
   * falls back to `baseSha` — byte-identical to the pre-#794 behaviour.
   */
  workstreamBaseShas?: Record<string, string>;
  /** Where conflict patches are preserved for the operator. */
  scratchDir: string;
  commitTitle: string;
  commitBody: string;
  mode: "create" | "followup";
  /** #577 — fail if ANY workstream produced no diff (commit-pr sets this). */
  requireAllNonEmpty?: boolean;
  /** #453 — pre-existing commit SHAs from a prior attempt (resume). */
  commitShas?: Record<string, string>;
  /**
   * The project's verify command, run against the CONSOLIDATED tree between
   * the commit and the push. Integration is the first place the combination
   * is compiled — every prior gate saw one workstream in isolation. Omitted
   * (or absent from the project) means the check is skipped, as before.
   */
  verifyCmd?: string;
  /** Executor for `verifyCmd`. Defaults to `execFn`; tests inject. */
  verifyExecFn?: ExecFn;
  /** Wall-clock for `verifyCmd`. */
  verifyTimeoutMs?: number;
  /**
   * #782 — the commit-pr flake re-run. When the consolidated verify at this
   * seam fails and `ciRetryCount` is unset (first consolidated run), the
   * SAME command re-runs once on the SAME integration branch (no restore at
   * this seam — repoRoot IS the consolidated tree) BEFORE classification.
   * `onRecover` is called with the original failing tail when the re-run
   * passes (the caller appends `verify-flake-recovered` BEFORE appending
   * `verify-failed:commit-pr`, so eventLog is append-only and the ordering
   * is the emission order). Absent on pre-#782 state files; readers treat
   * absent as no retry (the classifier parks as today).
   */
  verifyRetry?: {
    ciRetryCount?: number;
    onRecover: (evidenceTail?: string) => void;
  };
}

/** #492 — worktrees that produced no diff, keyed by id → worktree path. */
export type NoDiff = Record<string, string>;

/**
 * Check if a commit is already reachable from the integration branch.
 * Uses tree-hash comparison: identical trees = the commit is effectively
 * already applied (even if the SHA differs, e.g. from a resume). Returns
 * `false` on any read error (optimistic: cherry-pick if we can't verify).
 */
export async function isCommitOnBranch(
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
    return false;
  }
}

export type IntegrateResult =
  | {
      ok: true;
      workstreams: string[];
      empty: false;
      /** #492 — worktrees that were clean at stage time (the fixer/developer
       *  produced no diff there). Set only when at least one worktree was
       *  clean, so a caller can tell "this one wrote nothing" apart from the
       *  workstreams that did ship. */
      noDiff?: NoDiff;
      commitShas?: Record<string, string>;
      completeness?: ConsolidationCompleteness;
    }
  /** Nothing to integrate — every worktree was clean. Not an error. #492. */
  | {
      ok: true;
      workstreams: [];
      empty: true;
      noDiff: NoDiff;
      /** #749 — empty because every workstream's work was already on the
       *  branch (tree-hash dedup skip), not because nothing was produced. */
      skippedAlreadyOnBranch?: string[];
    }
  | {
      ok: false;
      reason: string;
      conflictPatch?: string;
      /** #492 — worktrees that produced no diff (for handoff context). */
      noDiff?: NoDiff;
      /** #539 — structured failure discriminator. Cause readers MUST read this, never re-parse `reason`. */
      failure?: "dirty-repoRoot" | "apply" | "verify";
      /** #654 task-c — dirty-preflight porcelain lines (the caller parks with these). */
      porcelain?: string[];
    };

/**
 * Consolidate every worktree onto the feature branch at repoRoot.
 * Fails rather than forces at every step. The dirty-repoRoot preflight runs
 * before `checkout -B` so operator residue is never silently carried onto
 * the feature branch (incident #602).
 */
export async function integrate(execFn: ExecFn, opts: IntegrateOpts): Promise<IntegrateResult> {
  const { repoRoot, branchName, worktrees, mode } = opts;
  // #794 — pick scope: own-range selection per workstream (see IntegrateOpts).
  const pickScope = { globalBaseSha: opts.baseSha, workstreamBaseShas: opts.workstreamBaseShas };
  const ids = Object.keys(worktrees);
  // Where repoRoot was before we touched it. A failed integration must put it
  // back: the previous code returned from inside the apply loop with the
  // checkout already switched and 0..N-1 workstreams already in the index, so
  // the operator found a half-applied branch; the NEXT cycle's dirty preflight
  // would refuse to run at all.
  let originalRef: string | undefined;
  // #750 — the restore is verified, not assumed (see work-driver-restore.ts).
  const restoreRoot = async (): Promise<VerifiedRestoreResult> =>
    originalRef
      ? verifiedRestoreRoot(execFn, {
          repoRoot,
          originalRef,
          scratchDir: opts.scratchDir,
          label: "integrate",
        })
      : { restored: true };
  // The verified post-condition via the shared claim builder, wrapped with
  // the ref the root was restored to (the helper's two shapes are kept
  // verbatim; the ref is load-bearing for the operator's retry).
  const claimFor = (r: VerifiedRestoreResult): string => {
    const claim = restoreClaim(r);
    return r.restored ? `repoRoot was restored to ${originalRef} (verified)` : claim;
  };
  try {
    // 1. Preflight: repoRoot must be clean of dirt before we touch its
    //    checkout. `.worktrees/` scaffolding is not dirt (driver's own
    //    scaffolding, never staged). Untracked `??` entries ARE dirt in the
    //    N=1 pre-#287 shape (worktree IS repoRoot, stagePorcelainPaths can
    //    sweep them into the PR) but are NOT dirt when the workstream's work
    //    lives in a separate worktree (#776) — in that shape integration
    //    (cherry-pick / patch-apply) never touches untracked files at repoRoot.
    //    The refusal parks (stash+pop tracked, refuse untracked) rather than
    //    stashing untracked files, which `stash push` without `-u` would drop.
    //    Same filter as consolidated-verify and handoff-consolidate — all
    //    three gates agree.
    const { stdout: rootStatus } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const rootDirt = rootStatus
      .split("\n")
      .filter((l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l));
    const anyWorktree = Object.values(worktrees).some(
      (p) => path.resolve(p) !== path.resolve(repoRoot),
    );
    if (rootDirt.length > 0) {
      // #776 — untracked-only dirt at repoRoot is non-blocking when the
      // workstream's work lives in a separate worktree: integration
      // (cherry-pick / patch-apply) never touches untracked files, and
      // the debris is outside the workstream's paths. The N=1 shape
      // (worktree IS repoRoot) still refuses because stagePorcelainPaths
      // can sweep untracked files into the PR.
      if (anyWorktree && rootDirt.every((l) => l.startsWith("??"))) {
        trace(
          `work-driver: integrate — untracked-only debris at repoRoot (non-blocking in worktree shape): ${rootDirt
            .slice(0, 5)
            .map((l) => l.slice(3))
            .join(", ")}`,
        );
      } else {
        const files = rootDirt
          .slice(0, 10)
          .map((l) => l.slice(3))
          .join(", ");
        return {
          ok: false,
          failure: "dirty-repoRoot",
          reason: `repo root has uncommitted changes (tracked or untracked), refusing to integrate onto ${branchName}: ${files}. Stash or commit tracked changes; for untracked files, move them elsewhere or add to .gitignore — integration would otherwise sweep them into the PR.`,
          porcelain: rootDirt,
        };
      }
    }

    // 2. Put repoRoot on the integration branch, remembering where it was.
    //    Detached HEAD has no symbolic ref — fall back to the raw sha.
    originalRef = await execFn("git symbolic-ref --quiet --short HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    })
      .then((r) => r.stdout.trim())
      .catch(async () =>
        (await execFn("git rev-parse HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 })).stdout.trim(),
      );
    if (mode === "create") {
      if (!opts.baseSha) return { ok: false, reason: "baseSha is required to create a branch" };
      await execFn(
        `git checkout -B ${JSON.stringify(branchName)} ${JSON.stringify(opts.baseSha)}`,
        { cwd: repoRoot, maxBuffer: 256 * 1024 },
      );
    } else {
      // #654 — a clean worktree holding the branch blocks the checkout
      // ("fatal: '<branch>' is already used by worktree at '…'"); a dirty
      // one throws DirtyWorktreeError. Runs under withIntegrationLock.
      await sweepBranchHolders(execFn, repoRoot, branchName);
      await execFn(`git checkout ${JSON.stringify(branchName)}`, {
        cwd: repoRoot,
        maxBuffer: 256 * 1024,
      });
    }

    // 3. Orchestrated cherry-pick + patch fallback (work-driver-cherry-pick.ts).
    //    The patch-fallback rebases a followup-mode lens-fix patch onto the
    //    branch's CURRENT head before applying it (#654 task-b).
    const orchResult = await orchestrateCherryPick(execFn, {
      repoRoot,
      branchName,
      worktrees: { ids, worktrees, commitShas: opts.commitShas ?? {} },
      baseSha: opts.baseSha,
      scratchDir: opts.scratchDir,
      requireAllNonEmpty: opts.requireAllNonEmpty,
      pickScope,
    });

    // Handle cherry-pick conflict — caller must abort and restore branch.
    // #750 — the claim states the VERIFIED post-condition only.
    if (orchResult._conflict === "conflict") {
      const restore = await restoreRoot();
      return {
        ok: false,
        failure: "apply",
        reason: `cherry-pick conflict — the batch was aborted. ${claimFor(restore)}.`,
      };
    }

    // Handle requireAllNonEmpty failure for a no-diff workstream.
    if (orchResult._noDiffRequireFail !== undefined) {
      const id = orchResult._noDiffRequireFail;
      const restore = await restoreRoot();
      return {
        ok: false,
        reason: `worktree '${id}' has no uncommitted work — nothing to consolidate. ${claimFor(restore)}.`,
        noDiff: Object.keys(orchResult.noDiff).length > 0 ? orchResult.noDiff : undefined,
      };
    }

    // Handle patch-apply failure.
    if (orchResult._applyConflict !== undefined) {
      const { id, reason: applyReason, patchFile } = orchResult._applyConflict;
      const emptySlice = orchResult.emptyWorkstreams.slice(
        orchResult.emptyWorkstreams.indexOf(id) + 1,
      );
      const skipped = emptySlice.length > 0 ? ` Not attempted: ${emptySlice.join(", ")}.` : "";
      const restore = await restoreRoot();
      return {
        ok: false,
        failure: "apply",
        reason:
          `git apply failed for workstream '${id}': ${applyReason}.` +
          `${skipped} ${claimFor(restore)}.`,
        conflictPatch: patchFile,
      };
    }

    const cherryApplied = orchResult.cherryApplied;
    const cherryPickShas = orchResult.cherryPickShas;
    const patchApplied = orchResult.patchApplied;
    const noDiff = orchResult.noDiff;

    // Commit staged changes (cherry-pick uses --no-commit; patch-apply is a no-op).
    const { stdout: hasStaged } = await execFn("git diff --cached --name-only", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (hasStaged.trim()) {
      await execFn(
        `git commit -m ${JSON.stringify(opts.commitTitle)} -m ${JSON.stringify(opts.commitBody)}`,
        { cwd: repoRoot, maxBuffer: 256 * 1024 },
      );
    }

    // Determine which workstreams actually produced output.
    const appliedWorkstreams = cherryApplied.length > 0 ? cherryApplied : patchApplied;
    // Check if cherry-picked workstreams were all no-ops.
    if (opts.baseSha) {
      const { stdout: headAhead } = await execFn(
        `git rev-list --count ${JSON.stringify(opts.baseSha)}..HEAD`,
        { cwd: repoRoot, maxBuffer: 64 * 1024 },
      );
      const ahead = Number.parseInt(headAhead.trim(), 10);
      if (!Number.isFinite(ahead) || ahead === 0) {
        // No commits ahead — every cherry-pick was a no-op or there was
        // nothing to do. Return empty rather than a spurious success.
        // #749 — carry the dedup discriminator: "nothing produced" vs
        // "work exists and its content is already on the branch".
        const skipped = orchResult.skippedAlreadyOnBranch ?? [];
        return {
          ok: true,
          workstreams: [],
          empty: true,
          noDiff,
          ...(skipped.length > 0 ? { skippedAlreadyOnBranch: skipped } : {}),
        };
      }
    } else {
      // No baseSha — check if there are staged changes (patch fallback).
      if (appliedWorkstreams.length === 0) {
        const { stdout: hasStaged2 } = await execFn("git diff --cached --name-only", {
          cwd: repoRoot,
          maxBuffer: 64 * 1024,
        });
        if (!hasStaged2.trim()) {
          const skipped = orchResult.skippedAlreadyOnBranch ?? [];
          return {
            ok: true,
            workstreams: [],
            empty: true,
            noDiff,
            ...(skipped.length > 0 ? { skippedAlreadyOnBranch: skipped } : {}),
          };
        }
      }
    }

    // 4. Verify the CONSOLIDATED tree before it becomes a PR. See `verifyCmd`.
    //    Rolling back on failure is safe: the worktrees still hold every
    //    workstream's commit — they are only advanced past it after a
    //    successful push, below.
    //    #777 — the classification happens here (the commit-pr twin seam) via
    //    the shared classifier, so the handoff names the specific assertion
    //    and the workstream combination instead of "the combination does not".
    if (opts.verifyCmd) {
      const verifyExec = opts.verifyExecFn ?? execFn;
      const vr = await runCommitPrConsolidatedVerify(verifyExec, {
        verifyCmd: opts.verifyCmd,
        repoRoot,
        workstreamCount: ids.length,
        workstreamIds: ids,
        timeoutMs: opts.verifyTimeoutMs,
        // #782 — pass the cycle's ciRetryCount through so the single flake
        // retry fires only on the FIRST consolidated run (ciRetryCount unset).
        isCiRetry: (opts.verifyRetry?.ciRetryCount ?? 0) > 0,
        onRecover: opts.verifyRetry?.onRecover,
      });
      if (vr.ok === false) {
        const restore = await restoreRoot();
        return {
          ok: false,
          failure: "verify",
          reason: `${vr.classifiedMessage} — it was not pushed. ${claimFor(restore)}.`,
        };
      }
    }

    // 5. Push.
    await execFn(`git push -u origin ${JSON.stringify(branchName)}`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });

    // Advance each cherry-picked worktree to the new HEAD — without this the
    // worktree keeps the developer's commit and the NEXT integration would
    // re-cherry-pick the same SHA (fails or creates a duplicate).
    const { stdout: newHead } = await execFn("git rev-parse HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const headSha = newHead.trim();
    if (headSha) {
      for (const id of appliedWorkstreams) {
        const wt = worktrees[id];
        if (!wt) continue;
        await execFn(`git reset --hard ${JSON.stringify(headSha)}`, {
          cwd: wt,
          maxBuffer: 256 * 1024,
        }).catch((err) =>
          trace(
            `work-driver: integrate — could not advance worktree '${id}' to ${headSha.slice(0, 8)}: ${(err as Error).message?.slice(0, 160)}`,
          ),
        );
      }
    }
    return {
      ok: true,
      workstreams: appliedWorkstreams,
      empty: false,
      noDiff: Object.keys(noDiff).length > 0 ? noDiff : undefined,
      commitShas: Object.keys(cherryPickShas).length > 0 ? cherryPickShas : undefined,
      completeness: orchResult.completeness,
    };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    // Anything that threw mid-integration leaves the same half-applied tree a
    // conflict does, so it gets the same treatment.
    const restore = await restoreRoot();
    return {
      ok: false,
      reason: `${(e.stderr ?? e.message ?? "unknown error").toString().trim().slice(0, 300)} ${claimFor(restore)}`,
    };
  }
}
