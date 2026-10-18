/**
 * #674 — consolidate the parked cycle's workstream work onto its feature branch
 * BEFORE the handoff body is rendered, split out of `work-driver-handoff.ts`
 * (which had reached the 500-line cap).
 *
 * Delegates to `work-driver-handoff-consolidate.ts` for the actual integration
 * (which runs under `withIntegrationLock`, respects integrate()'s dirty
 * repoRoot preflight, and degrades to a failure outcome rather than throwing).
 * Returns the `handoff-consolidated` event to append, or nothing when
 * consolidation was not possible (no branch, no work, no baseSha, dirty
 * repoRoot, conflict, or git error) — with the driver's reason, so the caller
 * degrades to the accurate per-worktree recovery AND says why.
 */

import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import { workNotYetOnBranch } from "./work-driver-handoff-ahead.ts";
import { consolidateWorktreesToBranch } from "./work-driver-handoff-consolidate.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * #1421 — the outcome the caller needs: the event to append on success, and
 * the driver's reason when consolidation was DECLINED. A single fixed
 * "consolidation infeasible" sentence used to cover both, so a cycle refused
 * by cargo's `target/` was indistinguishable from one whose cherry-picks
 * conflicted, and the operator was never told where the reviewed commits are.
 */
/** The most recent `handoff-consolidated` event in a log, if any. */
export function lastConsolidatedEvent(
  eventLog: readonly WorkEvent[],
): Extract<WorkEvent, { kind: "handoff-consolidated" }> | undefined {
  return [...eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "handoff-consolidated" }> =>
        e.kind === "handoff-consolidated",
    );
}

export interface ConsolidateOutcome {
  event?: Extract<WorkEvent, { kind: "handoff-consolidated" }>;
  degradedReason?: string;
}

export async function handoffConsolidateWorktrees(
  ctx: {
    repoRoot: string;
    issue: number;
    /** #1362 — forwarded to the consolidation's repoRoot reads (see there). */
    dirtyRootExempt?: readonly string[];
  },
  state: WorkState,
): Promise<ConsolidateOutcome> {
  if (process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE === "0") return {};
  if (!state.pipelineState.branchName) return {};
  const worktrees = state.pipelineState.worktrees ?? {};
  if (Object.keys(worktrees).length === 0) return {};
  // Re-entry guard: a second runHandoff (crash-resume re-post) must not
  // re-consolidate work that is already on the local branch.
  const notYet = await workNotYetOnBranch(
    execp,
    ctx.repoRoot,
    state.pipelineState.branchName,
    state.pipelineState.baseSha,
    worktrees,
  );
  if (!notYet) {
    trace("work-driver: handoff consolidation skipped — work already on the local branch");
    return {};
  }
  const scratch = scratchDir(ctx.repoRoot, ctx.issue);
  const result = await consolidateWorktreesToBranch(
    {
      repoRoot: ctx.repoRoot,
      issue: ctx.issue,
      scratchDir: scratch,
      dirtyRootExempt: ctx.dirtyRootExempt,
      // #1362 — the claim this consolidation builds names only the files the
      // cycle wrote; the cycle-start baseline is what makes that true.
      dirtyRootExemptBaseline: state.pipelineState.dirtyRootExemptBaseline,
    },
    state,
  );
  if (!result.ok) {
    trace(`work-driver: handoff consolidation degraded: ${result.reason}`);
    // #1421 — the reason survives the trace and reaches the handoff event, so
    // the operator sees WHY nothing landed instead of a fixed "infeasible".
    return { degradedReason: result.reason ?? "consolidation returned no reason" };
  }
  const branch = result.branchName ?? state.pipelineState.branchName;
  if (!branch) return {}; // no branchName — cannot consolidate
  return {
    event: {
      kind: "handoff-consolidated",
      at: Date.now(),
      branchName: branch,
      workstreams: result.workstreams ?? [],
      // #968 — the success path now restores repoRoot to the operator's
      // original checkout (branch checkout when originalRef is one); the claim
      // rides in the event so both renderers print the verified post-condition
      // or the loud not-restored failure. Absent when the restore was not run
      // (the nothing-applied short-circuit predates the capture on some paths).
      ...(result.restoreClaim !== undefined ? { restoreClaim: result.restoreClaim } : {}),
    },
  };
}
