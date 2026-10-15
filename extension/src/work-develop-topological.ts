/**
 * work-develop-topological — #679: the topological-dispatch core of runDevelop.
 *
 * Extracted from work-driver-branch-develop.ts (500-line gate) to give it
 * headroom. This is a pure move-and-reexport: no behaviour change. The
 * function is the #679 topological-dispatch core that `runDevelop` (the
 * Step-4 handler) delegates to; the per-workstream dispatch closure and the
 * dependent-workstream runner live in work-develop-run.ts.
 */
import { recordCommentEvidence } from "./comment-evidence.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import { runMergeRetryFlow } from "./work-develop-fence-merge-retry.ts";
import { siblingDeclaredViolators } from "./work-develop-fence-recovery.ts";
import {
  applyFenceVerdicts,
  replaceDevelopConvergedVerdicts,
} from "./work-develop-fence-verdicts.ts";
import { isValidBaseSha } from "./work-develop-git.ts";
import { downgradeReason } from "./work-develop-greens.ts";
import { refuseMissingWorktrees } from "./work-develop-missing-worktree.ts";
import {
  type PreservedGreens,
  greenCountsAsWork,
  makeBranchCompletedPersister,
  reRecordKeptGreens,
  recordDowngrade,
  retryResetFor,
  runIndependentFanout,
  withPersistNotes,
} from "./work-develop-retry.ts";
import {
  type DevelopRunState,
  makeRunOneWorkstream,
  runDependentWorkstreams,
} from "./work-develop-run.ts";
import { runSymbolMergeRetry } from "./work-develop-symbol-merge.ts";
import { appendDevelopVerifyFailure } from "./work-develop-verify-failure.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { topologicalDispatchOrder } from "./work-driver-dep-scheduler.ts";
import { clearDispatch } from "./work-driver-resume.ts";
import {
  applySafetyNet,
  hasAnyWorktreeEvidence,
  safetyNetWorktree,
} from "./work-driver-safety-net.ts";
import { armStepNotice } from "./work-driver-step-notice.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * #679 — topological-dispatch core of runDevelop (see work-develop-run.ts).
 */
async function runDevelopTopological(
  ctx: CycleContext,
  initialState: WorkState,
  ids: string[],
  workstreams: NonNullable<WorkState["pipelineState"]["workstreams"]>,
  activeIssues: number[],
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  now: number,
  jobId: string,
  preserved: PreservedGreens = { kept: new Set<string>(), notes: [] },
): Promise<WorkState> {
  void now;
  const begun = { jobId };
  let next = initialState;
  const scratchAbs = scratchDir(ctx.repoRoot, ctx.issue);
  let verdicts: Array<{
    id: string;
    ok: boolean;
    reason?: string;
    claimed?: true;
  }> = [];
  const branchEvents: WorkEvent[] = [];
  const dependsOnMap: Record<string, string[]> = {};
  for (const [id, ws] of Object.entries(workstreams)) {
    if (ws?.dependsOn && ws.dependsOn.length > 0) dependsOnMap[id] = ws.dependsOn;
  }
  const { independent, dependentOrdered } = topologicalDispatchOrder(ids, dependsOnMap);
  const stateRef = { current: next };
  const persistNotes: string[] = [...preserved.notes];
  const persister = makeBranchCompletedPersister(
    ctx.repoRoot,
    stateRef,
    persistNotes,
    ctx.emitSink,
    ctx.signal,
  );
  reRecordKeptGreens(persister, independent, preserved.kept);
  // #753 — per-workstream completion timestamps + a shared map of WHY each
  // failed-or-skipped workstream failed (the cascade event names the workstream
  // that ACTUALLY failed; a cascade is distinguishable from a legitimate skip).
  const depCompletedAtMap: Record<string, number> = {};
  // #753 — the independent phase is a parallel fan-out: the wall-clock moment
  // the fan-out resolves is the completion timestamp every dependent records.
  const independentCompletedAt = Date.now();
  const failureSource: Record<string, "skipped" | "failed"> = {};
  const runOneWorkstream = makeRunOneWorkstream({
    ctx,
    activeIssues,
    scratchAbs,
    workstreams: workstreams as DevelopRunState["workstreams"],
    emitBranchCompleted: persister.emit,
    ids,
    dispatch,
    // #838 — the develop dispatch's deck tag: the workstream id when N>1
    // (per-workstream rows), "default" for the single-workstream shape.
    deckTagFor: (id) => (ids.length > 1 ? id : "default"),
    // A getter: the fan-out replaces the verdict list, and dependents must push
    // into the current one.
    get verdicts() {
      return verdicts;
    },
    branchEvents: branchEvents as WorkEvent[],
    stateRef,
  });
  let worktrees = next.pipelineState.worktrees ?? {};
  let workstreamBaseShas = next.pipelineState.workstreamBaseShas ?? {};
  const globalBaseSha = next.pipelineState.baseSha;
  // #799 F2 — the step notice: the fan-out's wall-clock span, not any single
  // child's. The incident's silent window was a fan-out whose children were
  // each individually healthy (19–73 min) yet collectively ran ~2h — the
  // notice is keyed on the STEP's elapsed time so it fires on the incident
  // shape without alarming on a healthy 73-min child.
  const stepStartedAt = Date.now();
  const cancelStepNotice = armStepNotice({
    state: next,
    step: "develop",
    startedAt: stepStartedAt,
  });
  const endStep = (final: WorkState): WorkState => {
    cancelStepNotice();
    return final;
  };
  // #679 — a workstream is “blocked” for its dependents when its dispatch
  // failed OR when it produced NO commits ahead of its base (the case-2(c)
  // falsely-ok shape): building a dependent worktree on a dependency that
  // shipped nothing is the incoherent-tree failure this ticket fixes. The
  // #746 missing-worktree refusals below record into it before the fan-out.
  const failedOrSkipped = new Set<string>();
  // #746 — resolve each independent workstream's cwd from the worktrees map
  // BEFORE the fan-out. A workstream with no worktree entry has no valid
  // cwd: the pre-fix code fell back to ctx.repoRoot (worktrees[id] ??
  // ctx.repoRoot), so spawn.ts silently ran the developer in the Pi process
  // directory and the child wrote its deliverables at the repository root —
  // a cross-cycle poisoning channel (the #741 incident: a stray
  // extension/src/work-driver-converge.ts at the root refused the NEXT
  // cycle's consolidated verify ~50 minutes in). The correct behaviour is to
  // fail that workstream with a named error, never to silently fall back.
  // Deferred (depends-on) workstreams are not in `independent`: their cwd comes
  // from createDependentWorktree, which fails the workstream on its own.
  // #1016 — also refused: a resumed workstream whose work was not saved.
  const notDispatched = independent.filter(
    (id) => typeof worktrees[id] !== "string" || preserved.refused?.[id] !== undefined,
  );
  refuseMissingWorktrees({
    missing: notDispatched,
    reasons: preserved.refused,
    branchEvents,
    verdicts,
    failedOrSkipped,
    failureSource,
  });
  // #753 — the worktrees that exist as part of THIS cycle, keyed by workstream
  // id. Seeded from pipelineState (the branch step's creations) so the #545
  // same-issue dirty scan in the dependent phase treats this cycle's own
  // worktrees as in-flight work, not as "leftover" — otherwise an independent
  // workstream's legitimate in-progress dirt would park the cycle on a false
  // positive (the #545 scan is unbounded within a cycle). The dependent phase
  // grows this as it creates worktrees.
  const inCycleWorktrees: string[] = [...Object.values(worktrees)];

  // #746 — every dispatched independent has a worktree (the rest failed above).
  // #1016 — a green with no commits ahead of its base fails inside runAt.
  const firstPassFailed = new Set<string>();
  verdicts = await runIndependentFanout({
    independent,
    preserved: preserved.kept,
    skip: notDispatched,
    runAt: async (id) => {
      const cwd = worktrees[id];
      if (typeof cwd !== "string") return { id, ok: false, reason: "no worktree" };
      const r = await runOneWorkstream(id, cwd);
      if (!r.ok) return { id, ok: false, reason: r.reason };
      const base = workstreamBaseShas[id] ?? globalBaseSha;
      // #1016 — the #622 safety net commits leftover edits before the green check.
      if (isValidBaseSha(base)) {
        const sn = await safetyNetWorktree(id, ctx.repoRoot, cwd, base, execFn, persistNotes);
        if (sn) branchEvents.push(sn);
      }
      const green = await greenCountsAsWork(execFn, cwd, base);
      if (green.counts) return { ...r, claimed: true };
      recordDowngrade(persister, id, green.detail);
      return {
        id,
        ok: false,
        reason: downgradeReason(green.detail),
        claimed: true,
      };
    },
    resetFor: retryResetFor({
      execFn,
      repoRoot: ctx.repoRoot,
      scratchAbs,
      cwdFor: (id) => worktrees[id],
      baseFor: (id) => workstreamBaseShas[id] ?? globalBaseSha,
    }),
    verdicts,
    multi: ids.length > 1,
    notes: persistNotes,
    firstPassFailed,
  });
  for (const v of verdicts) if (!v.ok) failedOrSkipped.add(v.id);
  // #1016 — a first-pass failure keeps its dependents skipped, even when retried.
  for (const id of firstPassFailed) {
    failedOrSkipped.add(id);
    if (failureSource[id] === undefined) failureSource[id] = "failed";
  }
  // #753 — populate the dep-completion map: dependents wait on their DIRECT
  // dependency, so record the resolved fan-out time for every independent
  // workstream; the dependent phase records its own completion as it goes.
  for (const id of independent) depCompletedAtMap[id] = independentCompletedAt;
  const wtResult = await runDependentWorkstreams(
    ctx,
    dependentOrdered,
    workstreams,
    dependsOnMap,
    failedOrSkipped,
    verdicts,
    branchEvents,
    execFn,
    worktrees,
    workstreamBaseShas,
    globalBaseSha,
    ids,
    runOneWorkstream,
    {
      stateRef,
      inCycleWorktrees,
      depCompletedAtMap,
      failureSource,
      // #1016 — crash-resume and the selective retry reach the dependent phase too.
      kept: preserved.kept,
      refused: preserved.refused,
      notes: persistNotes,
      emitBranchCompleted: persister.emit,
      updateState: persister.update,
      flushState: persister.flush,
      resetFor: (id, cwd, base) =>
        retryResetFor({
          execFn,
          repoRoot: ctx.repoRoot,
          scratchAbs,
          cwdFor: () => cwd,
          baseFor: () => base,
        })(id),
    },
  );
  await persister.flush();
  worktrees = wtResult.worktrees;
  workstreamBaseShas = wtResult.workstreamBaseShas;
  next = stateRef.current;
  // #753 — a dirty-leftover refusal PARKED mid-step (cap-hit appended by
  // runDependentWorkstreams). The cap-hit must remain the event-log tail so
  // the step router routes the cycle to handoff on it: the sibling
  // branch-completed events are flushed BEFORE the cap-hit (parkDeferredLeftover
  // appends them first — verified against nextStep, which reads exactly the
  // last event and routes a trailing cap-hit to its nextStep), and running the
  // safety-net/verify gates (which append verifyEvidence / more events) would
  // displace it and the router would add a SECOND, generic cap on the
  // branches-converged verdict. Hence the short-circuit: no branches-converged,
  // no gates.
  if (wtResult.parked) {
    // #753 — the dependent phase parked mid-step (dirty-leftover cap-hit is the
    // tail). The write-ahead marker `beginDispatch` recorded for this step must
    // be cleared on this path too — the non-park path does it just below; on the
    // parked path the cycle terminates via handoff, but leaving the job in
    // inFlightJobIds would trip detectInconsistencies on a later read.
    next = stateRef.current;
    next = appendEvent(clearDispatch(next, begun.jobId));
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        worktrees,
        workstreamBaseShas: {
          ...workstreamBaseShas,
          ...next.pipelineState.workstreamBaseShas,
        },
      },
    };
    return endStep(withPersistNotes(next, persistNotes));
  }
  // The state ref above is the memory-inject appends' shared state; the slow
  // events the developer children recorded are collected in the driver's
  // pending buffer and drained at the step boundary (routeStepOutcome).
  next = stateRef.current;
  next = appendEvent(clearDispatch(next, begun.jobId), ...branchEvents);
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      worktrees,
      workstreamBaseShas: {
        ...workstreamBaseShas,
        ...next.pipelineState.workstreamBaseShas,
      },
    },
  };
  next = withPersistNotes(next, persistNotes);
  // #849 — the fence recovery reads `stateRef.current` (the shared ref the
  // memory-inject events and the gate operate on); keep it in sync with the
  // local `next` (the branchEvents + worktrees merge just applied).
  stateRef.current = next;
  if (ids.length > 1) {
    // #814 — the develop branches-converged emits here (after the
    // branch-completed batch, before the safety net and the develop verify
    // gate), unconditionally, carrying a COPY of the current verdicts (the
    // no-evidence path emits here too); exactly one per cycle. If the gate
    // below records fence violations, replaceDevelopConvergedVerdicts replaces
    // THIS event in place with the flipped verdicts (see work-develop-
    // fence-verdicts.ts).
    next = appendEvent(next, {
      kind: "branches-converged",
      step: "develop",
      verdicts: [...verdicts],
      at: Date.now(),
    });
  }
  // #679 (task-evidence) — the safety net and the develop verify gate are no
  // longer gated on the AGGREGATE verdict `verdicts.every(v => v.ok)`. That
  // old condition skipped BOTH gates for the whole fanout the moment any
  // single workstream failed (or was falsely-ok). Both gates now run when there
  // is ANY evidence to check: at least one worktree has commits ahead of its
  // base OR has uncommitted changes — the same condition verifyDevelopOutcome
  // itself computes per worktree.
  const hasDevelopEvidence =
    verdicts.some((v) => v.claimed === true) || (await hasAnyWorktreeEvidence(ctx, next));
  // #622 — mechanical auto-commit safety net. Fires per-worktree when a
  // developer left uncommitted work in their worktree (no commits ahead of the
  // workstream's effective base) after a successful dispatch. #679: independent
  // of sibling verdicts — a falsely-ok sibling no longer suppresses the safety
  // net for a legitimate uncommitted workstream. Escape hatch:
  // PI_ENSEMBLE_SAFETY_NET_COMMIT=0 disables it.
  if (hasDevelopEvidence) {
    // Only workstreams whose verdict is ok: a failed one's partial work stays uncommitted.
    next = await applySafetyNet(ctx, next, new Set(verdicts.filter((v) => v.ok).map((v) => v.id)));
    // #849 — the gate (and the fence flip below) operate on `stateRef.current`
    // (the shared state the memory-inject events accumulate into); keep the
    // local alias and the shared ref in sync so the flip's verdict replacement
    // is visible to the fence recovery that reads `stateRef.current`.
    stateRef.current = next;
  }
  // PR17 — outcome verification gate. Runs whenever the fanout produced any
  // evidence, not only when every branch claims success. The gate exists to
  // catch the case where claims are green but the evidence isn't. #679: one
  // failed workstream no longer skips the gate for the whole fanout.
  if (hasDevelopEvidence) {
    const gate = await verifyStepOutcome(ctx, next, "develop");
    // #1040 — lost-comment evidence persists from the develop note (handoff even with no reviewer).
    next = recordCommentEvidence(next, gate.commentEvidence);
    stateRef.current = next;
    // #814 — a fence violator must not report a bare "ok" here: replace the
    // event with the flipped verdicts via replaceDevelopConvergedVerdicts
    // (invariant named there; see work-develop-fence-verdicts.ts).
    if (gate.fenceViolations && ids.length > 1) {
      const flipped = applyFenceVerdicts(
        verdicts.map((v) => ({ ...v })),
        gate.fenceViolations,
      );
      const changed = flipped.some((v, i) => {
        const o = verdicts[i];
        return o === undefined || o.ok !== v.ok || o.reason !== v.reason;
      });
      if (changed) {
        next = replaceDevelopConvergedVerdicts(next, flipped);
      }
    }
    // #1005 — the fence merge-and-retry (replaces the #849 fence recovery,
    // which re-ran the same split and failed the same way every time): when
    // the gate recorded a BLOCKING sibling-declared violation (and no
    // issue-fenced one, which still blocks as today), the driver MERGES the
    // coupled workstreams (owner keeps its id; violator absorbed), re-dispatches
    // ONCE on the merged one, and re-runs the fence + verify gates (the full
    // flow lives in work-develop-fence-merge.ts / work-develop-fence-
    // merge-retry.ts). A second failure after merging hands off, naming the
    // merge. `issue-fenced` and `undeclared` records never merge: the
    // condition is exactly "sibling-declared only". The gate runs on
    // `stateRef.current` (the flip above wrote the verdicts there), not the
    // local `next`.
    const recoverableFence =
      gate.fenceViolations !== undefined &&
      siblingDeclaredViolators(gate.fenceViolations).length > 0 &&
      !gate.fenceViolations.some((f) => f.kind === "issue-fenced");
    if (gate.ok === false && recoverableFence) {
      // #849 — the gate's fence records are not yet on `pipelineState`
      // (the develop step writes them only on a failure path, after the
      // gate returns). Stash them so `recoverFenceViolations` (which reads
      // `stateRef.current.pipelineState.verifyEvidence`) sees the first
      // attempt's records for the cycle check and the discard evidence.
      next = {
        ...next,
        pipelineState: {
          ...next.pipelineState,
          verifyEvidence: {
            step: "develop",
            failures: gate.failures,
            at: Date.now(),
            fenceViolations: gate.fenceViolations ?? [],
          },
        },
      };
      stateRef.current = next;
      // #1005 — the merge-and-retry (replaces the #849 fence recovery, which
      // re-ran the same split and failed the same way every time): merge the
      // coupled workstreams, re-dispatch ONCE on the merged one, re-run the
      // gates. A second failure after merging hands off (naming the merge).
      next = await runMergeRetryFlow(ctx, next, stateRef, ids, verdicts, execFn, dispatch);
      return endStep(next);
    }
    if (gate.ok) {
      // #782 — the consolidated verify's single re-run passed: the driver
      // proceeds. Emit the recovery marker BEFORE the converge gate so the
      // event log carries the audit trail even if the cycle parks later.
      if (gate.flakeRecovered) {
        next = appendEvent(next, {
          kind: "verify-flake-recovered",
          at: Date.now(),
          step: "develop",
        });
      }
      // #741 — the verify gate proves the diff BUILDS; the converge gate
      // proves it is COMPLETE. Runs only after the verify gate passes (the
      // issue's stated ordering) — a diff that doesn't build never reaches
      // the completeness check. Skips silently when disabled, when there is
      // no normalised spec, or when the diff is unreadable.
      next = await runConvergeGateHandler(ctx, next, dispatch);
    } else {
      // #1323 — a failure naming a symbol a sibling's diff adds merges the
      // pair and retries once (work-develop-symbol-merge.ts); otherwise park.
      const merged = await runSymbolMergeRetry(
        ctx,
        next,
        stateRef,
        ids,
        verdicts,
        gate,
        execFn,
        dispatch,
      );
      next = merged ?? appendDevelopVerifyFailure(next, gate);
    }
  }
  return endStep(next);
}

// #841 — re-exported for the smoke test's direct bound check (the N=1
// gate cannot produce the 10-failure shape, so the test exercises the
// join bound in isolation).
export { boundJoinFailures as boundJoinFailuresForTest };

export { runDevelopTopological };
