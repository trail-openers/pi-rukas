/**
 * work-driver-adversarial-lensfix — the lens-fix integration of the adversarial
 * step (#287 Part C, #749, #797), moved VERBATIM out of work-driver-adversarial.ts
 * (AGENTS.md §12 file-size limit; #1114 needs the room). Called only from
 * `runAdversarial` on the approval that follows a lens-fix round.
 */

import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { integrate, restoreRepoRoot } from "./work-driver-integrate.ts";
import {
  detectCommittedFix,
  landCommittedFix,
  noDiffEvidence,
  repoRootOriginalRef,
} from "./work-driver-lens-fix-commit.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { isNetGitTimeout, netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/** #287 Part C — re-integrate a lens-fix made in a worktree (#654 task-c). */
async function integrateLensFix(
  execFn: ExecFn,
  ctx: DriverContext,
  ps: PipelineState,
  worktrees: Record<string, string>,
): Promise<{ committed: boolean; error?: string; pushed?: boolean }> {
  const branchName = ps.branchName;
  if (!branchName) return { committed: false, error: "no branch name recorded" };
  const round = ps.reviewRound;
  const res = await withIntegrationLock(ctx.repoRoot, () =>
    integrate(execFn, {
      repoRoot: ctx.repoRoot,
      branchName,
      worktrees,
      // #794 — own-range selection (stacked workstreams: see workstreamBaseShas).
      workstreamBaseShas: ps.workstreamBaseShas,
      scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
      commitTitle: `fix(lens): round ${round} review findings`,
      commitBody: `Addresses six-pass review findings from round ${round}.`,
      mode: "followup",
    }),
  );
  if (!res.ok) {
    if (res.failure === "dirty-repoRoot" && res.porcelain) {
      const outcome = await restoreRepoRoot(execFn, ctx.repoRoot, res.porcelain);
      if (outcome.restored) {
        const retry = await integrate(execFn, {
          repoRoot: ctx.repoRoot,
          branchName,
          worktrees,
          // #794 — same pick scope as the first pass above.
          workstreamBaseShas: ps.workstreamBaseShas,
          scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
          commitTitle: `fix(lens): round ${round} review findings`,
          commitBody: `Addresses six-pass review findings from round ${round}.`,
          mode: "followup",
        });
        if (!retry.ok) {
          return {
            committed: false,
            error: `restored repoRoot (stash+pop) but the retry still failed: ${retry.reason}`,
          };
        }
        if (retry.empty) return { committed: false };
        return { committed: true, pushed: true };
      }
      return {
        committed: false,
        error: `dirty repoRoot at lens-fix time, not safely restorable — ${outcome.reason}. Porcelain: ${res.porcelain
          .slice(0, 5)
          .join("; ")}`,
      };
    }
    return { committed: false, error: res.reason };
  }
  if (res.empty) return { committed: false };
  return { committed: true, pushed: true };
}

/** #749/#797 — committed-work classification for the `!result.committed` branch. */
async function handleNoCommittedFix(
  execFn: ExecFn,
  ctx: DriverContext,
  ps: PipelineState,
  fixTree: string,
  result: { committed: boolean; error?: string; pushed?: boolean },
  stateIn: WorkState,
): Promise<WorkState | null> {
  let state = stateIn;
  if (result.error) return null;
  if (!ps.branchName) {
    return appendEvent(state, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "lens-fix-not-integrated",
      reviewRound: ps.reviewRound,
      nextStep: "handoff",
      lensWorktreePath: fixTree,
      evidence: `no committed fix and no branch name recorded — cannot measure committed work in ${fixTree}`,
    });
  }
  const branchName = ps.branchName;
  const fix = await detectCommittedFix(execFn, fixTree, branchName);
  if (fix.status === "committed") {
    if (fix.diffEmpty) {
      trace(
        "work-driver: lens-fix committed and already on the branch — proceeding to re-review (no cap)",
      );
      return null;
    }
    const landed = await landCommittedFix(execFn, ctx, ps, fixTree);
    if (landed.ok) {
      // #776 — ok covers both "landed" and "tree-hash-dedup skip" (#749).
      // The work is on the branch; no cap.
      const sha = landed.sha;
      let pushFailure: string | undefined;
      const pushRefProblem = netRefProblem(branchName);
      if (pushRefProblem !== undefined) {
        pushFailure = `push refused: ${pushRefProblem}`;
      } else {
        try {
          await runNetGit(execFn, "git", {
            cwd: ctx.repoRoot,
            argv: ["push", "origin", branchName],
          });
        } catch (err) {
          // #1095 — keep the named timeout cause visible to the operator.
          pushFailure = isNetGitTimeout(err) ? err.message.slice(0, 200) : "push rejected";
        }
      }
      if (pushFailure !== undefined) {
        state = {
          ...state,
          pipelineState: {
            ...state.pipelineState,
            plumbReports: [
              ...state.pipelineState.plumbReports,
              {
                step: "adversarial",
                role: "driver",
                body: `lens-fix landed locally but the push failed (${pushFailure}) — check the remote for ${branchName}`,
                at: Date.now(),
              },
            ],
          },
        };
      }
      trace(
        `work-driver: lens-fix committed fix ${sha.slice(0, 8)} landed on ${branchName} — proceeding to re-review`,
      );
      return null;
    }
    // #776 — integration genuinely failed (e.g. cherry-pick conflict).
    // #797 — the restore outcome rides in `landed.error`; naming the
    // pre-integration ref makes the post-condition checkable.
    const preIntegrationRef = await repoRootOriginalRef(execFn, ctx.repoRoot);
    return appendEvent(state, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "lens-fix-not-integrated",
      reviewRound: ps.reviewRound,
      nextStep: "handoff",
      lensWorktreePath: fixTree,
      restoredToRef: preIntegrationRef,
      evidence: `committed fix in ${fixTree} (${fix.count} commit(s) ahead of ${branchName}) — integration genuinely failed: ${landed.error}. repoRoot condition after the restore: ${landed.error.includes("repoRoot was verified restored") || landed.error.includes("repoRoot was restored") ? "restored" : landed.error.includes("repoRoot was NOT restored") ? "NOT restored — manual repair required" : "unknown"}${preIntegrationRef ? ` (the cycle started from ${preIntegrationRef})` : ""}. The fix's worktree HEAD SHA is recorded in the handoff snapshot's committedWork so it can be recovered (git cherry-pick from ${fixTree}).`,
    });
  }
  const evidence =
    fix.status === "no-commits"
      ? noDiffEvidence(fixTree, branchName, fix.count)
      : `no committed fix and the count of commits ahead of ${branchName} in ${fixTree} could not be read (git error)`;
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "lens-fix-not-integrated",
    reviewRound: ps.reviewRound,
    nextStep: "handoff",
    lensWorktreePath: fixTree,
    evidence,
  });
}

export { handleNoCommittedFix, integrateLensFix };
