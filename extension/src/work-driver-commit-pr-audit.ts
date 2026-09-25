/**
 * work-driver-commit-pr-audit — #861: the commit-pr ops-fallback audit
 * (decision (4)).
 *
 * Split from work-driver-commit.ts for the AGENTS.md §12 500-line cap (the
 * #861 fallback plumbing pushed it over). Owns the post-dispatch
 * branch-holder audit: after the ops child returned, the integration branch
 * must be held ONLY by the driver-owned integrate worktree — or by nothing.
 * Any other holder (the #841 shape: #841's ops child checked its branch out
 * inside #844's worktree) halts the cycle with the dedicated
 * `integration-worktree-violation` cap BEFORE the PR-verification gates
 * (runCommitPrPostDispatchGates) can validate a PR opened from the wrong
 * tree.
 *
 * Also owns the conditional integrate-worktree removal: the tree is
 * REMOVED once commit-pr SUCCEEDS (the post-dispatch gates all green) and
 * KEPT on any handoff halt (violation or gate cap) for operator inspection.
 * The mechanized path (fallbackFired === false) never created the tree, so
 * it skips straight to the gates.
 *
 * Sibling worktree HEADs are deliberately NOT compared — concurrent cycles
 * legitimately commit in their own detached worktrees during the window.
 */
import { trace } from "./trace.ts";
import { runCommitPrPostDispatchGates } from "./work-driver-commit-pr-events.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  branchHolders,
  integrateWorktreeName,
  integrateWorktreePath,
} from "./work-driver-integrate-worktree.ts";
import { appendEvent } from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";
import { worktreeRemove } from "./worktree.ts";
import { resolvePath } from "./worktree.ts";
import type { ExecFn } from "./worktree.ts";

export async function auditCommitPrFallback(
  ctx: DriverContext,
  execFn: ExecFn,
  next: WorkState,
  fallbackFired: boolean,
): Promise<WorkState> {
  if (!fallbackFired) return runCommitPrPostDispatchGates(ctx, execFn, next);
  // #861 — post-dispatch branch-holder audit (decision (4)): the integration
  // branch must now be held by the integrate worktree — or by nothing. Any
  // other holder (the #841 shape) halts the cycle with the dedicated cap,
  // BEFORE the PR-verification gates can validate a PR opened from the wrong
  // tree.
  //
  // The cycle's OWN worktrees (ps.worktrees) are NOT a violation. The ops
  // fallback prompt's non-fallback multi-workstream shape (still reachable:
  // the `fallback` arg is passed unconditionally, so a fallback cycle with a
  // populated worktrees map is multi-shape) instructs the child to apply each
  // patch in the integrate worktree, but the CHILD decides where the branch
  // ends up — a stub/child that commits in its own worktree (ps.worktrees[id])
  // still produces a valid PR (the branch is pushed; the consolidate gate
  // verifies the committed diff). The #841 defect is the branch held in an
  // UNRELATED cycle's worktree (a sibling's tree), not this cycle's own.
  const auditBranch = next.pipelineState.branchName ?? "";
  const holders = await branchHolders(execFn, ctx.repoRoot, auditBranch);
  const integratePath = integrateWorktreePath(ctx.repoRoot, ctx.issue);
  const ownTrees = new Set(
    Object.values(next.pipelineState.worktrees ?? {}).map((p) => resolvePath(p)),
  );
  const bad = holders.find(
    (h) =>
      resolvePath(h) !== resolvePath(integratePath) &&
      !ownTrees.has(resolvePath(h)) &&
      resolvePath(h) !== resolvePath(ctx.repoRoot),
  );
  if (bad !== undefined) {
    trace(
      `work-driver: commit-pr fallback audit — integration branch held by ${bad} (expected ${integratePath} or nothing) — halting before PR verification`,
    );
    return appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "integration-worktree-violation",
      evidence: `holder: ${bad} (integration branch ${auditBranch}; expected holder ${integratePath})`,
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }
  // #861 — the integrate worktree is removed once commit-pr has SUCCEEDED
  // (fallback + the post-dispatch gates all green). A gate halt (or the
  // violation halt above) routes to handoff, where the tree is KEPT for
  // inspection — so the removal is conditional on the tail staying clean.
  const gated = await runCommitPrPostDispatchGates(ctx, execFn, next);
  // A gate halt (commit-pr-incomplete-consolidation / verify-failed:commit-pr)
  // routes to handoff — the tree is kept there for inspection, same as the
  // violation halt above. Only a clean tail means the PR was verified.
  const gatedLast = gated.eventLog[gated.eventLog.length - 1];
  if (gatedLast?.kind !== "cap-hit") {
    const removal = worktreeRemove(execFn, ctx.repoRoot, integrateWorktreeName(ctx.issue), true);
    await removal.catch((err) =>
      trace(`work-driver: integrate worktree removal failed: ${(err as Error).message}`),
    );
    trace(
      `work-driver: commit-pr SUCCEEDED — removed the driver-owned integrate worktree ${integrateWorktreePath(ctx.repoRoot, ctx.issue)} (kept on handoff)`,
    );
  }
  return gated;
}
