/** #287 Part B — the ONLY path that writes to repoRoot. */

import path from "node:path";
import { trace } from "./trace.ts";
import { orchestrateCherryPick } from "./work-driver-cherry-pick.ts";
import type { ConsolidationCompleteness } from "./work-driver-completeness.ts";
import { isConfiguredExemptDirtLine } from "./work-driver-dirty-root-exempt.ts";
import { integrationEmptiness } from "./work-driver-integrate-emptiness.ts";
import { fastForwardOnto, rewindFastForward } from "./work-driver-integrate-ff.ts";
import { sweepBeforeFollowupCheckout } from "./work-driver-integrate-sweep.ts";
import { verifyIntegration } from "./work-driver-integrate-verify-step.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import type { ExecFn } from "./worktree.ts";
// Re-exported for backward compatibility (callers imported these from
// work-driver-integrate.ts pre-#750; the implementations now live in
// work-driver-preflight.ts).
export { readDirtyPorcelain, restoreRepoRoot } from "./work-driver-preflight.ts";

// #794 — the integration lock lives in work-driver-lock.ts (extracted to
// keep this file under the 500-line gate); the re-exports below preserve
// every existing import path unchanged.

import type { IntegrateResult } from "./work-driver-integrate-result.ts";

// The result contract lives in work-driver-integrate-result.ts and is re-exported
// here so every consumer keeps importing it from the module that owns `integrate()`.
export type { IntegrateResult };
import { cachedIssueTitle } from "./work-driver-integrate-title.ts";
export { cachedIssueTitle } from "./work-driver-integrate-title.ts";

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
  /**
   * #1362 — the cycle's `.pi/dirty-root-exempt` list. Applied to the repoRoot
   * dirty-root preflight and the verified restore's claims; the worktree
   * staging is deliberately NOT filtered, so a deliverable inside an exempt
   * prefix is still committed.
   */
  dirtyRootExempt?: readonly string[];
  commitTitle: string;
  commitBody: string;
  mode: "create" | "followup";
  /**
   * #1468 — step 3 fast-forwards the branch to the worktree HEAD instead of
   * cherry-picking, so a merge commit keeps both parents (`--continue-pr`).
   */
  fastForward?: boolean;
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
  /**
   * #1240 — the single worktree whose content the develop gate verified
   * green, when the integration is exactly that: ONE workstream, whose work
   * arrived by cherry-pick (not a patch transplant, which adds no commit and
   * is the shape `integrate()` step 4 verifies). The caller (mechanized
   * commit-pr) supplies the develop worktree for the N=1 create-mode cycle.
   * When supplied, step 4 skips its verify run if the committed integration
   * tree is the tree that passed. Any other shape must leave this absent.
   */
  verifiedWorktree?: string;
  /** Wall-clock for `verifyCmd`. */
  verifyTimeoutMs?: number;
  /**
   * #1404 — the cycle's ORIGINAL base commit (`pipelineState.baseSha`), the
   * commit this cycle's commits are measured against. Threaded to the
   * commit-pr verify so a consolidated failure earns a baseline probe. The
   * caller must NOT pass a followup round's `followupBase` — that commit
   * already carries this cycle's earlier commits, which would excuse every
   * failure as pre-existing. Absent → no probe, failures park as before.
   */
  baselineBaseSha?: string;
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
 * Check if a commit is already on the integration branch: either it is in
 * the branch's history, or its tree is the branch head's tree (the commit
 * is effectively already applied even if the SHA differs, e.g. from a
 * resume). The tree test alone only ever recognises the commit AT the tip:
 * a second lens-fix round starts on the integrated tip, so its
 * `baseSha..HEAD` range holds every commit already on the branch, and
 * re-picking the ones behind the tip conflicts with the fixes made since.
 * Returns `false` on any read error (optimistic: cherry-pick if we can't
 * verify).
 */
export async function isCommitOnBranch(
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
  repoRoot: string,
  branchName: string,
  sha: string,
): Promise<boolean> {
  try {
    // `0` commits of `sha`'s history missing from HEAD = `sha` is in it. A
    // count, not `merge-base --is-ancestor`'s exit status, so an executor
    // that answers nothing is never read as "already there".
    const { stdout: missing } = await execFn(`git rev-list --count HEAD..${sha}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (missing.trim() === "0") return true;
  } catch {
    // Unreadable — fall through to the tree test.
  }
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

/**
 * Consolidate every worktree onto the feature branch at repoRoot.
 * Fails rather than forces at every step. The dirty-repoRoot preflight runs
 * before `checkout -B` so operator residue is never silently carried onto
 * the feature branch (incident #602).
 */
export async function integrate(execFn: ExecFn, opts: IntegrateOpts): Promise<IntegrateResult> {
  const { repoRoot, branchName, worktrees, mode } = opts;
  // #1362 — the exemption list this consolidation reads repoRoot with.
  const dirtyRootExempt = opts.dirtyRootExempt;
  // #794 — pick scope: own-range selection per workstream (see IntegrateOpts).
  const pickScope = { globalBaseSha: opts.baseSha, workstreamBaseShas: opts.workstreamBaseShas };
  const ids = Object.keys(worktrees);
  // Where repoRoot was before we touched it. A failed integration must put it
  // back: the previous code returned from inside the apply loop with the
  // checkout already switched and 0..N-1 workstreams already in the index, so
  // the operator found a half-applied branch; the NEXT cycle's dirty preflight
  // would refuse to run at all.
  let originalRef: string | undefined;
  // #1240 — set only when step 4 skipped its verify run; carried on the
  // success result so the caller can record the visible event.
  let verifySkipped: AlreadyVerifiedTree | undefined;
  // #1404 — set when step 4's verify failed ONLY on tests that already fail
  // at the cycle's base commit. The push below proceeds on it; the names ride
  // on the success result so the caller can make them visible.
  let verifyPreExisting: string[] | undefined;
  // #750 — the restore is verified, not assumed (see work-driver-restore.ts).
  // #1468 — the branch tip before a fast-forward; every unpushed exit rewinds to it.
  let ffFrom: string | undefined;
  const restoreRoot = async (): Promise<VerifiedRestoreResult> => {
    const restored: VerifiedRestoreResult = originalRef
      ? await verifiedRestoreRoot(execFn, {
          repoRoot,
          originalRef,
          scratchDir: opts.scratchDir,
          label: "integrate",
          dirtyRootExempt,
        })
      : { restored: true };
    if (ffFrom) await rewindFastForward(execFn, repoRoot, branchName, ffFrom);
    return restored;
  };
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
      .filter(
        (l) =>
          l.trim() &&
          !/^..\s+"?\.worktrees\//.test(l) &&
          !isConfiguredExemptDirtLine(l, dirtyRootExempt),
      );
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
      // #654 / #1396 (round 3) — the sweep and its refusal contract live in
      // work-driver-integrate-sweep.ts: only a repoRoot that is not a
      // repository degrades to "no holder"; a hang/lock/kill halts.
      await sweepBeforeFollowupCheckout(execFn, repoRoot, branchName);
      await execFn(`git checkout ${JSON.stringify(branchName)}`, {
        cwd: repoRoot,
        maxBuffer: 256 * 1024,
      });
    }

    // 3. Orchestrated cherry-pick + patch fallback (work-driver-cherry-pick.ts).
    //    The patch-fallback rebases a followup-mode lens-fix patch onto the
    //    branch's CURRENT head before applying it (#654 task-b).
    if (opts.fastForward) {
      ffFrom = (await execFn("git", { argv: ["rev-parse", "HEAD"], cwd: repoRoot })).stdout.trim();
    }
    const orchResult = opts.fastForward
      ? await fastForwardOnto(execFn, repoRoot, ids, worktrees, {
          title: opts.commitTitle,
          body: opts.commitBody,
          exempt: dirtyRootExempt,
        })
      : await orchestrateCherryPick(execFn, {
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

    // Determine which workstreams actually produced output. (#749 — the
    // "nothing produced" vs "already on the branch" discrimination, and both
    // modes' evidence shapes, live in `integrationEmptiness`.)
    const appliedWorkstreams = cherryApplied.length > 0 ? cherryApplied : patchApplied;
    const emptiness = await integrationEmptiness(execFn, {
      repoRoot,
      baseSha: opts.baseSha,
      appliedWorkstreams,
      skippedAlreadyOnBranch: orchResult.skippedAlreadyOnBranch,
    });
    if (emptiness.empty) {
      // `...emptiness` carries `empty: true` plus the #749 dedup discriminator;
      // `noDiff` is the orchestrator's own map, kept under the field name the
      // callers already read.
      return { ok: true, workstreams: [], noDiff, ...emptiness };
    }

    // 4. Verify the CONSOLIDATED tree before it becomes a PR — the seam
    //    itself is `verifyIntegration` (work-driver-integrate-verify-step.ts):
    //    rolling back on failure is safe only because the worktrees still hold
    //    every workstream's commit, and #777's classification happens there.
    //    #1240's skip is decided inside it, not here.
    const integrationVerify = await verifyIntegration(execFn, {
      repoRoot,
      ids,
      cherryApplied,
      patchApplied,
      noDiff,
      mode,
      verifiedWorktree: opts.verifiedWorktree,
      verifyCmd: opts.verifyCmd,
      verifyExecFn: opts.verifyExecFn,
      verifyTimeoutMs: opts.verifyTimeoutMs,
      baselineBaseSha: opts.baselineBaseSha,
      // #1404 — the workstream worktrees are extra trees the change run's
      // failing-test names may live under (see IntegrationVerifyOpts).
      changeRoots: Object.values(worktrees),
      verifyRetry: opts.verifyRetry,
      restoreRoot,
      claimFor,
    });
    if (integrationVerify.failure !== undefined) return integrationVerify.failure;
    verifyPreExisting = integrationVerify.preExistingFailures;
    verifySkipped = integrationVerify.skipped;

    // #1468 — a refresh pushes nothing when main is red too; commit-pr parks.
    if (opts.fastForward && verifyPreExisting !== undefined) {
      await restoreRoot();
      const names = { preExistingOnly: true, preExistingFailures: verifyPreExisting } as const;
      return { ok: true, workstreams: appliedWorkstreams, empty: false, ...names };
    }

    // 5. Push.
    const pushRefProblem = netRefProblem(branchName);
    if (pushRefProblem !== undefined) throw new Error(`push refused: ${pushRefProblem}`);
    await runNetGit(execFn, "git", {
      cwd: repoRoot,
      argv: ["push", "-u", "origin", branchName],
    });

    // Advance each cherry-picked worktree to the new HEAD — without this the
    // worktree keeps the developer's commit and the NEXT integration would
    // re-cherry-pick the same SHA (fails or creates a duplicate).
    const { stdout: newHead } = await execFn("git rev-parse HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const headSha = newHead.trim();
    trace(`work-driver: integrate — pushed ${branchName} @ ${headSha.slice(0, 8)}`);
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
      ...(verifySkipped !== undefined ? { verifySkipped } : {}),
      ...(verifyPreExisting !== undefined
        ? { preExistingOnly: true, preExistingFailures: verifyPreExisting }
        : {}),
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
