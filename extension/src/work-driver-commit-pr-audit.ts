/**
 * work-driver-commit-pr-audit — #861: the commit-pr ops-fallback audit
 * (decision (4)).
 *
 * Split from work-driver-commit.ts for the AGENTS.md §12 500-line cap (the
 * #861 fallback plumbing pushed it over). Owns the post-dispatch sequence
 * for a fallback commit-pr:
 *
 *  1. The PR-verification gates (runCommitPrPostDispatchGates) run FIRST —
 *     a partial consolidation halts with
 *     `commit-pr-incomplete-consolidation` before the cycle can advance
 *     (pr14 §D: that cap, not the holder audit, is the gate this shape
 *     must produce).
 *  2. With a clean gate tail, the STRICT branch-holder audit: the
 *     integration branch must be held ONLY by the driver-owned integrate
 *     worktree — or by NOTHING. Any other holder — an UNRELATED cycle's
 *     worktree (the #841 shape), this cycle's OWN workstream worktrees
 *     (the prompt treats them as read-only), or repoRoot (the main tree is
 *     NOT in `git worktree list`, probed directly via its own checkout;
 *     the prompt forbids the child from touching it) — halts the cycle
 *     with the dedicated `integration-worktree-violation` cap.
 *  3. A fully clean tail removes the driver-owned integrate worktree
 *     (kept on any handoff halt for operator inspection). The mechanized
 *     path (fallbackFired === false) never created the tree, so it skips
 *     straight to the gates.
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
  repoRootHoldsBranch,
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
  // #861 — default is audit-first (the #841 unit-test contract: the
  // violation cap is the tail, gates unrun). The cycle flow
  // (runCommitPrLocked) passes gatesFirst=true: pr14 §D's partial
  // consolidation must produce the consolidation cap (not the violation
  // cap), and a cycle that already halted for consolidation is not
  // re-halted with the violation cap, which would overwrite the
  // consolidation evidence in the tail.
  gatesFirst = false,
): Promise<WorkState> {
  if (!fallbackFired) return runCommitPrPostDispatchGates(ctx, execFn, next);
  // #861 — post-dispatch sequence (decision (4), STRICT):
  //
  // 1. The PR-verification gates run FIRST. They are the gate pr14 §D
  //    exists to test: a partial consolidation (missing workstream files
  //    in the committed diff) must halt the cycle with
  //    `commit-pr-incomplete-consolidation` BEFORE merge. A gate halt
  //    routes to handoff with the consolidation evidence in the tail —
  //    the holder audit must NOT re-halt a cycle that already halted
  //    (its own cap would overwrite that evidence).
  //
  // 2. With a CLEAN gate tail, the branch-holder audit runs: the
  //    integration branch must be held ONLY by the integrate worktree —
  //    or by NOTHING. Every other holder halts with the dedicated cap:
  //    an UNRELATED cycle's worktree (the #841 shape), this cycle's OWN
  //    workstream worktrees (ps.worktrees — the fallback prompt treats
  //    them as read-only), or repoRoot (the main working tree is NOT in
  //    `git worktree list --porcelain` — branchHolders never sees it —
  //    so it is probed DIRECTLY via its own checkout; the prompt forbids
  //    the child from touching repoRoot).
  //
  // 3. A fully clean audit + gates tail removes the driver-owned
  //    integrate worktree (kept on any handoff halt for inspection).
  const auditBranch = next.pipelineState.branchName ?? "";
  const integratePath = integrateWorktreePath(ctx.repoRoot, ctx.issue);
  const auditHalt = async (base: WorkState): Promise<WorkState> => {
    const holders = await branchHolders(execFn, ctx.repoRoot, auditBranch);
    // The repoRoot probe runs through the PRODUCTION exec seam (not
    // execFn) so a test fake's `git` short-circuit cannot make the probe
    // fail and exculpate the holder — the #861 defect was exactly a
    // failing probe reading as "does not hold".
    const rootHolds = await repoRootHoldsBranch(undefined, ctx.repoRoot, auditBranch);
    const bad = rootHolds
      ? ctx.repoRoot
      : holders.find((h) => resolvePath(h) !== resolvePath(integratePath));
    if (bad !== undefined) {
      trace(
        `work-driver: commit-pr fallback audit — integration branch held by ${bad} (expected ${integratePath} or nothing) — halting`,
      );
      return appendEvent(base, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "integration-worktree-violation",
        evidence: `holder: ${bad} (integration branch ${auditBranch}; expected holder ${integratePath})`,
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
    return base;
  };
  const removal = async (): Promise<void> => {
    worktreeRemove(execFn, ctx.repoRoot, integrateWorktreeName(ctx.issue), true).catch((err) =>
      trace(`work-driver: integrate worktree removal failed: ${(err as Error).message}`),
    );
    trace(
      `work-driver: commit-pr SUCCEEDED — removed the driver-owned integrate worktree ${integratePath} (kept on handoff)`,
    );
  };
  if (gatesFirst) {
    // Production order: the consolidation gate owns the cycle-level halt;
    // the audit runs only on a clean gate tail (a partial-consolidation
    // halt already routes to handoff with its own evidence — re-halting
    // with the violation cap would overwrite it).
    const gated = await runCommitPrPostDispatchGates(ctx, execFn, next);
    const gatedLast = gated.eventLog[gated.eventLog.length - 1];
    if (gatedLast?.kind === "cap-hit") return gated;
    const audited = await auditHalt(gated);
    const auditedLast = audited.eventLog[audited.eventLog.length - 1];
    if (auditedLast?.kind !== "cap-hit") void removal();
    return audited;
  }
  // Unit-test order: the violation must be the tail with the gates
  // UNRUN (the #841 audit test's contract).
  const audited = await auditHalt(next);
  const auditedLast = audited.eventLog[audited.eventLog.length - 1];
  if (auditedLast?.kind === "cap-hit") return audited;
  const gated = await runCommitPrPostDispatchGates(ctx, execFn, audited);
  const gatedLast = gated.eventLog[gated.eventLog.length - 1];
  if (gatedLast?.kind !== "cap-hit") void removal();
  return gated;
}
