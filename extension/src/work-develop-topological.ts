/**
 * work-develop-topological — #679: the topological-dispatch core of runDevelop.
 *
 * Extracted from work-driver-branch-develop.ts (500-line gate) to give it
 * headroom. This is a pure move-and-reexport: no behaviour change. The
 * function is the #679 topological-dispatch core that `runDevelop` (the
 * Step-4 handler) delegates to; the per-workstream dispatch closure and the
 * dependent-workstream runner live in work-develop-run.ts.
 */
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import { parkOnDevelopCrash } from "./work-develop-crash.ts";
import { isValidBaseSha } from "./work-develop-git.ts";
import { settleCommitlessGreen } from "./work-develop-green-gate.ts";
import { childOwnWork, downgradeReason } from "./work-develop-greens.ts";
import { refuseMissingWorktrees } from "./work-develop-missing-worktree.ts";
import { flushParkedSiblings } from "./work-develop-parked-flush.ts";
import {
  type PreservedGreens,
  greenCountsAsWork,
  makeBranchCompletedPersister,
  reRecordKeptGreens,
  retryResetFor,
  runIndependentFanout,
  withPersistNotes,
} from "./work-develop-retry.ts";
import {
  type DevelopRunState,
  makeRunOneWorkstream,
  runDependentWorkstreams,
} from "./work-develop-run.ts";
import { developUnfinishedPass } from "./work-develop-unfinished-pass.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { onDevelopVerifyFailed } from "./work-driver-corrective-round.ts";
import { topologicalDispatchOrder } from "./work-driver-dep-scheduler.ts";
import { recordDevelopVerdict } from "./work-driver-develop-verdict.ts";
import { parkDevelopFixOverrun } from "./work-driver-lens-fix-budget.ts";
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
    noRetry?: true;
  }> = [];
  const branchEvents: WorkEvent[] = [];
  const dependsOnMap: Record<string, string[]> = {};
  for (const [id, ws] of Object.entries(workstreams)) {
    if (ws?.dependsOn && ws.dependsOn.length > 0) dependsOnMap[id] = ws.dependsOn;
  }
  const { independent, dependentOrdered } = topologicalDispatchOrder(ids, dependsOnMap);
  const stateRef = { current: next };
  // #1644 — the shared budget-park marker (see DevelopRunState.budgetPark):
  // the closure marks it instead of dispatching a doomed fix pass; the check
  // below turns the mark into the step's short-circuit, with the cap-hit
  // landing as the tail the step router reads. #1774: REQUIRED, so a
  // construction site cannot forget the mechanism it reads.
  const budgetPark: { at?: number } = {};
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
  // #1403 — the base a crashed pass's worktree is described against. Resolved
  // lazily (the dependent phase adds entries as it creates worktrees) and
  // identical to `effectiveBaseForWorkstream` in the #622 safety net, so a
  // pass judged "done" and a tree the net later commits share one base.
  const basesFor = (id: string): string | undefined =>
    next.pipelineState.workstreamBaseShas?.[id] ?? next.pipelineState.baseSha;
  const runOneWorkstream = makeRunOneWorkstream({
    ctx,
    activeIssues,
    scratchAbs,
    workstreams: workstreams as DevelopRunState["workstreams"],
    emitBranchCompleted: persister.emit,
    ids,
    dispatch,
    // #1403 — the fan-out reads the crashed tree with the step's own executor
    // and the ONE base resolution the step has (`baseFor`: the live
    // `pipelineState` map with the global fallback, read at classify time), so
    // "done" is judged against the tree the gates later judge. The classify
    // seam itself is not threaded: both phases call the real classifier with
    // these two, which is all they contribute.
    execFn,
    baseFor: basesFor,
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
    budgetPark,
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
      // #1774 — the budget refusal's `noRetry` marker rides through this
      // wrapper: dropped here, the fan-out would treat a deterministic
      // refusal as a transient failure and retry it. #1768 — so does the
      // `unfinished` marker: the green gate below distinguishes a mid-step quit
      // from an ordinary failure by it, and the corrective round resumes only
      // from a pass the classify seam actually called unfinished.
      if (!r.ok)
        return {
          id,
          ok: false,
          reason: r.reason,
          ...(r.noRetry ? { noRetry: true } : {}),
          ...(r.unfinished ? { unfinished: true } : {}),
        };
      const base = workstreamBaseShas[id] ?? globalBaseSha;
      // #1768 — the green is decided by the pass's OWN commits (the classify
      // seam read them inside `runOneWorkstream`, discounting the driver's own
      // recovery commits), BEFORE the #622 net sees the tree. Pre-#1768 the net
      // ran first: it commits the leftover dirt when a pass has 0 commits ahead,
      // and that driver-made commit then satisfied the rule — orchard
      // cycle-id's `agent done: developer` beside `safety net committed
      // default (d81ce007)` while the child's own last line said work remained.
      // The rule and the downgrade it records are `work-develop-green-gate.ts`,
      // shared with the dependent phase so neither can call the same tree two
      // different things; the net stays here because earning it IS the green.
      if (!childOwnWork(r)) return settleCommitlessGreen(r, persister.emit);
      // A pass with its own commits earns the net: leftover edits it never
      // staged are recovered, and its untracked work would otherwise be lost.
      if (isValidBaseSha(base)) {
        const sn = await safetyNetWorktree(id, ctx.repoRoot, cwd, base, execFn, persistNotes);
        if (sn) branchEvents.push(sn);
      }
      return { ...r, claimed: true };
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
  // #1768 — a pass that quit mid-step earns its ONE corrective round, and parks
  // on `develop-incomplete-uncommitted` if that round fails too; the rule and
  // its reasoning are in `work-develop-unfinished-pass.ts`, this is the routing.
  const unfinishedPass = await developUnfinishedPass({
    ctx,
    stateRef,
    state: next,
    worktrees,
    workstreamBaseShas,
    globalBaseSha,
    workstreams,
    activeIssues,
    scratchAbs,
    dispatch,
    execFn,
    basesFor,
    persister,
    branchEvents,
    verdicts,
    ids,
    budgetPark,
    persistNotes,
    begunJobId: begun.jobId,
  });
  next = unfinishedPass.state;
  if (unfinishedPass.parked) {
    // The cap-hit is the log tail and the step ends here, as the two parks
    // below do.
    return endStep(withPersistNotes(unfinishedPass.result, persistNotes));
  }
  // The round's verdicts replace the ones it re-dispatched, so dependents see
  // whether their dependency actually finished.
  for (const id of unfinishedPass.blocked) {
    failedOrSkipped.add(id);
    if (failureSource[id] === undefined) failureSource[id] = "failed";
  }
  for (const id of unfinishedPass.recovered) failedOrSkipped.delete(id);
  // #753 — the dep-completion map: dependents wait on their DIRECT dependency.
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
      execFn,
      // #1403 — the same single base resolution the independent fan-out uses:
      // `pipelineState`, which the phase writes through the shared persister
      // as each dependent's worktree and base are created.
      baseFor: basesFor,
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
    // `[]`: the dependent phase's own events (the failing dependent plus its
    // skip cascade) were already flushed by `parkDeferredLeftover`, which put
    // them before its cap-hit — re-flushing here would duplicate them.
    next = flushParkedSiblings(stateRef.current, begun.jobId, [], worktrees, workstreamBaseShas);
    return endStep(withPersistNotes(next, persistNotes));
  }
  // #1644 — the review-loop budget parked a fix pass: nothing was dispatched
  // for it, and the safety-net/verify gates would append events AFTER the cap
  // and displace the tail the step router reads (the same reason the
  // deferred-leftover short-circuit above exists). Flush the siblings AND the
  // dependents' skip-cascade events (the same set the parked branch flushes,
  // #1742 MINOR 2 — one helper, so the two parks cannot drift), then let the
  // budget module land its cap-hit as the tail and persist.
  if (budgetPark.at !== undefined) {
    // #1774 — the adjudication runs on the instant the REFUSAL was decided
    // (`startedAt` in the dispatch closure), not on a fresh `Date.now()` here:
    // the sibling flush above takes wall-clock time, and re-reading the clock
    // after it made "does the step fit the budget the loop has left?" a
    // question about a moment that no longer described the refusal.
    next = flushParkedSiblings(
      stateRef.current,
      begun.jobId,
      branchEvents,
      worktrees,
      workstreamBaseShas,
    );
    next = await parkDevelopFixOverrun(ctx, withPersistNotes(next, persistNotes), budgetPark.at);
    return endStep(next);
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
  // #1403 — a develop child whose ENGINE DIED is a step outcome, not a
  // completion; the whole park (verdict filter, console notice, cap-hit with
  // the leftover paths named) lives in work-develop-crash.ts so this file
  // stays under the §12 gate and the rule has one home next to its record.
  const crashPark = parkOnDevelopCrash(next, ctx.issue);
  if (crashPark) return endStep(crashPark);
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
    // #1667 — the verdict is recorded and routed by the one shared function, which the
    // corrective round's re-verify also calls: a corrected cycle takes the same path.
    // #1323 — a failure naming a symbol a sibling's diff adds merges the pair and
    // retries once (work-develop-symbol-merge.ts); otherwise the corrective round
    // may answer it, and a second failure parks.
    next = await recordDevelopVerdict({
      ctx,
      state: next,
      stateRef,
      ids,
      verdicts,
      gate,
      execFn,
      dispatch,
      onVerifyFailed: (s, g) =>
        onDevelopVerifyFailed({
          ctx,
          state: s,
          stateRef,
          ids,
          workstreams,
          verdicts,
          gate: g,
          execFn,
          dispatch,
        }),
    });
  }
  return endStep(next);
}

// #841 — re-exported for the smoke test's direct bound check (the N=1
// gate cannot produce the 10-failure shape, so the test exercises the
// join bound in isolation).
export { boundJoinFailures as boundJoinFailuresForTest };

export { runDevelopTopological };
