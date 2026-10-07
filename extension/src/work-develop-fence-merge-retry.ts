/**
 * work-develop-fence-merge-retry — #1005: the develop step's fence
 * merge-and-retry (gate re-run + the honest verdict/restore decision).
 *
 * Replaces the #849 fence-recovery flow (work-develop-fence-recovery-run.ts),
 * which re-ran the SAME split (discard the violator's commit, re-dispatch the
 * violator against the owner's files) — the exact failure #1005 measured:
 * re-running the split fails the same way every time, because the two
 * workstreams are coupled and no re-division of the same work makes each
 * half pass its own gate.
 *
 * #1005's response to a `sibling-declared` fence violation is to MERGE the
 * two coupled workstreams and re-run develop ONCE on the merged one:
 *
 *   1. The violating workstream V and its declaring owner O are merged into
 *      a single workstream (same shape as the MAX_WORKSTREAMS fold in
 *      work-driver-plan-workstreams.ts:116-124 and the plan-time coupling
 *      merge in work-driver-plan-coupling.ts: union of paths/outOfScope,
 *      scope annotated, dependsOn re-pointed).
 *   2. The merged workstream's worktree is V's worktree, rebased to O's
 *      post-commit tip (the #849 reset: O's commit is the base the merged
 *      work builds on).
 *   3. The merged workstream is re-dispatched ONCE with a prompt that names
 *      the merge and tells the developer both halves are now their scope.
 *   4. The fence + verify gates re-run. A clean re-run proceeds through the
 *      converge gate. A SECOND failure (fence or verify) hands off, and the
 *      handoff evidence NAMES THE MERGE (both the first and second attempt,
 *      plus the merge itself).
 *
 * This module owns step 4 (the gate re-run) and the honest verdict/restore
 * decision; the merge + rebase + re-dispatch (steps 1–3) live in
 * work-develop-fence-merge.ts (the 500-line seam).
 *
 * Parking rules (the #849 cycle check is subsumed: a violator↔owner cycle is
 * itself the merge — there is no "injected edge" to form a cycle with, so the
 * cycle check has no work to do here):
 *   - a git failure rebasing V to O's tip parks with the `fence-violation:develop`
 *     cap, naming the merge and the failing command (ZERO re-dispatch).
 *   - a second failure after the merge hands off (the #1005 acceptance
 *     criterion: "A second failure after merging hands off, and the handoff
 *     names the merge").
 *   - at most one merge-and-retry round per cycle (the gate re-runs at most
 *     twice; only the first pass may merge).
 *
 * The discriminator is the record KIND from the gate's `fenceViolations` —
 * `sibling-declared` only (same as #849). `issue-fenced` violations still
 * block exactly as today (no recovery), and `undeclared` records (warn-only)
 * never trigger the merge.
 */
import {
  fenceCapHit,
  mergeEvidence,
  runMergePrep,
  secondViolationProse,
} from "./work-develop-fence-merge.ts";
import {
  applyFenceVerdicts,
  replaceDevelopConvergedVerdicts,
} from "./work-develop-fence-verdicts.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { applySafetyNet } from "./work-driver-safety-net.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

// #1005 — the merge-retry prompt lives with the merge half (it is part of
// the re-dispatch step) — re-exported so callers that imported it from here
// keep their import path.
export { mergeRetryPrompt } from "./work-develop-fence-merge.ts";

/**
 * #1005 — the full merge-and-retry flow. `runMergeRetryFlow` is the entry
 * point called from runDevelopTopological when the gate records a
 * `sibling-declared` fence violation (and no `issue-fenced` one, which still
 * blocks as today).
 *
 * The flow:
 *   1. Merge each (violator, owner) pair + rebase + re-dispatch the merged
 *      workstreams (runMergePrep in work-develop-fence-merge.ts).
 *   2. Re-run the fence + verify gates. A clean re-run proceeds through the
 *      converge gate. A second failure (fence or verify) hands off — the
 *      cap-hit evidence names the MERGE (both halves, both attempts).
 */
export async function runMergeRetryFlow(
  ctx: DriverContext,
  stateIn: WorkState,
  stateRef: { current: WorkState },
  ids: string[],
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
): Promise<WorkState> {
  const { state, outcome } = await runMergePrep(ctx, stateIn, stateRef, ids, execFn, dispatch);
  if (outcome.parked) return state;
  const { mergedIds, merges, discardedShas } = outcome;
  if (mergedIds.length === 0) return state; // no sibling-declared violation — nothing to merge
  // The re-run always gates: the merge produced evidence (the re-dispatch
  // committed work, or the rebase reset the worktree to the owner's tip).
  let next = state;
  next = await applySafetyNet(ctx, next);
  const gate2 = await verifyStepOutcome(ctx, next, "develop");
  const rereRunRecords = gate2.fenceViolations ?? [];
  const blockingSecond = rereRunRecords.filter(
    (f) => f.kind === "sibling-declared" || f.kind === "issue-fenced",
  );
  // The RESTORE is honest: a merged workstream returns to ok:true ONLY when
  // the re-run gate ran, gate2.ok is true, AND no blocking fence record
  // names it; otherwise it stays ok:false.
  const mergedSet = new Set(mergedIds);
  const reRanClean = gate2.ok && blockingSecond.every((r) => !mergedSet.has(r.workstreamId));
  if (reRanClean) {
    for (let i = 0; i < verdicts.length; i++) {
      const v = verdicts[i];
      if (!v) continue;
      if (mergedSet.has(v.id) && v.ok === false) {
        verdicts[i] = { id: v.id, ok: true };
      }
    }
  } else {
    for (let i = 0; i < verdicts.length; i++) {
      const v = verdicts[i];
      if (!v) continue;
      if (mergedSet.has(v.id) && v.ok !== false) {
        verdicts[i] = { id: v.id, ok: false };
      }
    }
  }
  if (blockingSecond.length > 0 && ids.length > 1) {
    const flipped2 = applyFenceVerdicts(
      verdicts.map((v) => ({ ...v })),
      rereRunRecords,
    );
    const changed2 = flipped2.some((v, i) => {
      const o = verdicts[i];
      return o === undefined || o.ok !== v.ok || o.reason !== v.reason;
    });
    if (changed2) {
      next = replaceDevelopConvergedVerdicts(next, flipped2);
      for (let i = 0; i < verdicts.length; i++) {
        const f = flipped2[i];
        if (f) verdicts[i] = { ...f };
      }
    }
  }
  next = replaceDevelopConvergedVerdicts(
    next,
    verdicts.map((v) => ({ ...v })),
  );
  // The PARK decision keys on the re-run's fence RECORDS. A second
  // violation (or a verify failure) after the merge hands off — the
  // #1005 acceptance criterion: the handoff names the MERGE.
  if (blockingSecond.length > 0) {
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        verifyEvidence: {
          step: "develop",
          failures: gate2.failures,
          at: Date.now(),
          fenceViolations: gate2.fenceViolations ?? [],
        },
      },
    };
    next = appendEvent(
      next,
      fenceCapHit(
        next,
        `fence violated again AFTER the merge-and-retry (${mergeEvidence(merges, discardedShas)}; second: ${secondViolationProse(gate2.fenceViolations ?? [])}) — a second failure after merging hands off; re-running the same split will not converge`,
      ),
    );
    return next;
  }
  if (gate2.ok) {
    next = await runConvergeGateHandler(ctx, next, dispatch);
    return next;
  }
  // The re-run failed without a blocking fence record: a genuine verify
  // failure after the merge. Hand off — the #1005 criterion (a second
  // failure after merging hands off, naming the merge).
  const failureEvidence =
    gate2.failures.length > 0 ? gate2.failures.join(" | ") : "(no failure string)";
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      verifyEvidence: {
        step: "develop",
        failures: gate2.failures,
        at: Date.now(),
        ...(gate2.fenceViolations ? { fenceViolations: gate2.fenceViolations } : {}),
      },
    },
  };
  next = appendEvent(
    next,
    fenceCapHit(
      next,
      `verify failed AFTER the merge-and-retry (${mergeEvidence(merges, discardedShas)}) — ${failureEvidence}; a second failure after merging hands off`,
    ),
  );
  return next;
}
