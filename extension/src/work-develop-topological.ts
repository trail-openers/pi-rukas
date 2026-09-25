/**
 * work-develop-topological — #679: the topological-dispatch core of runDevelop.
 *
 * Extracted from work-driver-branch-develop.ts (500-line gate) to give it
 * headroom. This is a pure move-and-reexport: no behaviour change. The
 * function is the #679 topological-dispatch core that `runDevelop` (the
 * Step-4 handler) delegates to; the per-workstream dispatch closure and the
 * dependent-workstream runner live in work-develop-run.ts.
 */
import { trace } from "./trace.ts";
import {
  applyFenceVerdicts,
  describeSiblingFenceViolations,
  replaceDevelopConvergedVerdicts,
} from "./work-develop-fence-verdicts.ts";
import {
  type DevelopRunState,
  makeRunOneWorkstream,
  runDependentWorkstreams,
} from "./work-develop-run.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { topologicalDispatchOrder } from "./work-driver-dep-scheduler.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import { clearDispatch } from "./work-driver-resume.ts";
import { applySafetyNet, hasAnyWorktreeEvidence } from "./work-driver-safety-net.ts";
import { armStepNotice } from "./work-driver-step-notice.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkEvent, type WorkState, appendEvent, writeState } from "./workflow-state.ts";

// #841 — per-failure / joined-evidence bounds for the cap-hit evidence
// field. A failure string is already an 800-char attributed tail; a
// fanout with several failures joined unboundedly produced multi-KB
// evidence. Bound each failure and the join itself, with a truncation
// marker so the operator knows the evidence is bounded.
const CAP_EVIDENCE_PER_FAILURE_MAX = 800;
const CAP_EVIDENCE_TOTAL_MAX = 4000;
const CAP_EVIDENCE_TRUNCATED = " … (truncated)";

/** #841 — bound a single failure string before it is joined into evidence. */
function boundFailure(f: string): string {
  return extractAttributedTail(f, CAP_EVIDENCE_PER_FAILURE_MAX).tail || f.slice(-800);
}

/** #841 — join bounded failures, capping the total with a truncation marker. */
function boundJoinFailures(failures: string[]): string {
  const joined = failures.map(boundFailure).join(" | ");
  if (joined.length <= CAP_EVIDENCE_TOTAL_MAX) return joined;
  return joined.slice(0, CAP_EVIDENCE_TOTAL_MAX) + CAP_EVIDENCE_TRUNCATED;
}

/**
 * #679 — topological-dispatch core of runDevelop (see work-develop-run.ts).
 */
async function runDevelopTopological(
  ctx: DriverContext,
  initialState: WorkState,
  ids: string[],
  workstreams: NonNullable<WorkState["pipelineState"]["workstreams"]>,
  activeIssues: number[],
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  now: number,
  jobId: string,
): Promise<WorkState> {
  void now;
  const begun = { jobId };
  let next = initialState;
  const scratchAbs = scratchDir(ctx.repoRoot, ctx.issue);
  const verdicts: Array<{ id: string; ok: boolean; reason?: string }> = [];
  const branchEvents: WorkEvent[] = [];
  const dependsOnMap: Record<string, string[]> = {};
  for (const [id, ws] of Object.entries(workstreams)) {
    if (ws?.dependsOn && ws.dependsOn.length > 0) dependsOnMap[id] = ws.dependsOn;
  }
  const { independent, dependentOrdered } = topologicalDispatchOrder(ids, dependsOnMap);
  const stateRef = { current: next };
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
    ids,
    dispatch,
    verdicts,
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
  // Deferred (depends-on) workstreams legitimately have no entry here —
  // they are not in `independent` (their cwd comes from
  // createDependentWorktree in the dependent phase, which already fails the
  // workstream on a creation failure).
  const missingWorktree = independent.filter((id) => typeof worktrees[id] !== "string");
  if (missingWorktree.length > 0) {
    for (const id of missingWorktree) {
      const err = `no worktree recorded for workstream ${id} (worktrees map has no entry) — dispatch refused rather than falling back to repoRoot`;
      branchEvents.push({
        kind: "dispatch-failed",
        step: "develop",
        role: "developer",
        jobId: "unknown",
        label: ids.length > 1 ? `developer[${id}]` : "developer",
        ms: 0,
        at: Date.now(),
        errorTail: err.slice(0, 200),
      });
      branchEvents.push({
        kind: "branch-completed",
        step: "develop",
        workstreamId: id,
        ok: false,
        ms: 0,
        at: Date.now(),
        error: err,
      });
      verdicts.push({ id, ok: false });
      failedOrSkipped.add(id);
      if (failureSource[id] === undefined) failureSource[id] = "failed";
      trace(`work-driver: develop refused for ${id} — ${err}`);
    }
  }
  // #753 — the worktrees that exist as part of THIS cycle, keyed by workstream
  // id. Seeded from pipelineState (the branch step's creations) so the #545
  // same-issue dirty scan in the dependent phase treats this cycle's own
  // worktrees as in-flight work, not as "leftover" — otherwise an independent
  // workstream's legitimate in-progress dirt would park the cycle on a false
  // positive (the #545 scan is unbounded within a cycle). The dependent phase
  // grows this as it creates worktrees.
  const inCycleWorktrees: string[] = [...Object.values(worktrees)];

  // #746 — every dispatched independent now has a worktree (the missing ones
  // failed above); the lookup can no longer fall back to ctx.repoRoot.
  const dispatchedIndependents = independent.filter((id) => !missingWorktree.includes(id));
  const independentResults = await Promise.all(
    dispatchedIndependents.map((id) => runOneWorkstream(id, worktrees[id] as string)),
  );
  for (const r of independentResults) {
    if (!r.ok) failedOrSkipped.add(r.id);
  }
  // #753 — populate the dep-completion map: dependents wait on their DIRECT
  // dependency, so record the resolved fan-out time for every independent
  // workstream; the dependent phase records its own completion as it goes.
  for (const id of independent) depCompletedAtMap[id] = independentCompletedAt;
  for (const id of independent) {
    // #746 — a missing worktree was already failed (dispatch refused); it
    // cannot be evidence-checked (there is no tree), and is already in
    // failedOrSkipped, so skip it.
    if (typeof worktrees[id] !== "string") continue;
    const cwd = worktrees[id];
    const base = workstreamBaseShas[id] ?? globalBaseSha;
    if (typeof base === "string" && /^[0-9a-f]{40}$/.test(base)) {
      try {
        const { stdout } = await execFn(`git rev-list --count ${base}..HEAD`, {
          cwd,
          maxBuffer: 64 * 1024,
        });
        if (Number.parseInt(stdout.trim(), 10) === 0) failedOrSkipped.add(id);
      } catch {
        failedOrSkipped.add(id); // unresolvable → treat as blocked (fail-safe)
      }
    } else {
      failedOrSkipped.add(id); // no valid base → treat as blocked (fail-safe)
    }
  }
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
    { stateRef, inCycleWorktrees, depCompletedAtMap, failureSource },
  );
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
        workstreamBaseShas: { ...workstreamBaseShas, ...next.pipelineState.workstreamBaseShas },
      },
    };
    return endStep(next);
  }
  void independentResults;
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
      workstreamBaseShas: { ...workstreamBaseShas, ...next.pipelineState.workstreamBaseShas },
    },
  };
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
  const hasDevelopEvidence = await hasAnyWorktreeEvidence(ctx, next);
  // #622 — mechanical auto-commit safety net. Fires per-worktree when a
  // developer left uncommitted work in their worktree (no commits ahead of the
  // workstream's effective base) after a successful dispatch. #679: independent
  // of sibling verdicts — a falsely-ok sibling no longer suppresses the safety
  // net for a legitimate uncommitted workstream. Escape hatch:
  // PI_ENSEMBLE_SAFETY_NET_COMMIT=0 disables it.
  if (hasDevelopEvidence) {
    next = await applySafetyNet(ctx, next);
  }
  // PR17 — outcome verification gate. Runs whenever the fanout produced any
  // evidence, not only when every branch claims success. The gate exists to
  // catch the case where claims are green but the evidence isn't. #679: one
  // failed workstream no longer skips the gate for the whole fanout.
  if (hasDevelopEvidence) {
    const gate = await verifyStepOutcome(ctx, next, "develop");
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
      // #669 — a cherry-pick conflict during the develop-time consolidated
      // verify is a consolidation error (two workstreams' changes cannot
      // combine), not a verify failure: retrying the verify command cannot
      // fix it. Route it to its own cap so the operator sees the conflict
      // with its evidence instead of being told the verify failed. #794 —
      // explainCap (not this message) distinguishes a stacked cycle from an
      // independent fanout overlap; the stacked distinction belongs there
      // because the cap is the operator-facing explanation seam.
      const conflictFailure = gate.failures.find((f) =>
        /cherry-pick \/ apply conflict|could not combine the workstreams/.test(f),
      );
      // #814 — when the consolidated-verify-conflict cap fires on a
      // sibling-declared fence violation, the cap-hit EVIDENCE carries the
      // shared attribution sentence (describeSiblingFenceViolations — the
      // same wording as the handoff's explainConsolidation fence branch), so
      // the operator sees "workstream X touched F, declared by workstream Y"
      // at the cap itself, not only in the rendered explanation. (The
      // gate's failure string, recorded on verifyEvidence.failures, carries
      // the full attribution too; the evidence is the tail-visible seam.)
      const fenceProse = gate.fenceViolations
        ? describeSiblingFenceViolations(gate.fenceViolations)
        : undefined;
      // #777 — a consolidation-created verify failure (per-workstream pass,
      // combined fail on a specific assertion) is a THIRD distinct cap,
      // separate from both the conflict cap and the generic verify-failed:
      // develop. The failure message carries the classification label, the
      // specific assertion, and both workstream ids — the operator gets a
      // precise handoff instead of "consolidated tree fails verify".
      const consolidationCreatedFailure = gate.failures.find((f) =>
        /\[consolidation-created\]/.test(f),
      );
      const cap = conflictFailure
        ? "consolidated-verify-conflict"
        : consolidationCreatedFailure
          ? "consolidated-verify-consolidation-created"
          : "verify-failed:develop";
      trace(`work-driver: ${cap} — ${gate.failures.join(" | ")}`);
      // #782 — when the consolidated verify recovered from a flake but the
      // converge gate then parks, record the retry so the handoff shows
      // "retried once, recovered" even though the cycle stops here.
      next = {
        ...next,
        pipelineState: {
          ...next.pipelineState,
          verifyEvidence: {
            step: "develop",
            failures: gate.failures,
            at: Date.now(),
            ...(gate.fenceViolations ? { fenceViolations: gate.fenceViolations } : {}),
            ...(gate.flakeRecovered ? { retries: 1, recovered: true } : {}),
          },
        },
      };
      // #841 — the verify-failed:develop cap always carries evidence. The
      // pre-fix spread attached it only for the conflict and
      // consolidation-created branches, so the generic N=1 shape (issue
      // #840) parked with NO evidence field at all — the handoff had
      // nothing to name beyond verifyEvidence.failures, and the raw verify
      // output (persisted to the scratch dir by the consolidated gate, the
      // failure strings below) was unreferenceable. Every verify failure is
      // now named at the cap itself; the fence prose suffixes the conflict /
      // consolidation-created wording (the attribution belongs on both caps).
      // Each failure is bounded before the join, and the join itself is
      // capped (the #841 unbounded-evidence fix).
      const failureEvidence =
        conflictFailure ?? consolidationCreatedFailure ?? boundJoinFailures(gate.failures);
      // #841 — the log path the gate actually wrote, carried STRUCTURALLY on
      // the cap event (the explain renderer renders it without regexing the
      // evidence prose); absent when the gate wrote no log.
      const logPaths = gate.logPath !== undefined ? [gate.logPath] : undefined;
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap,
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
        evidence:
          failureEvidence +
          (conflictFailure || consolidationCreatedFailure
            ? fenceProse
              ? ` [fence: ${fenceProse}]`
              : ""
            : ""),
        ...(logPaths !== undefined ? { logPaths } : {}),
      });
    }
  }
  return endStep(next);
}

// #841 — re-exported for the smoke test's direct bound check (the N=1
// gate cannot produce the 10-failure shape, so the test exercises the
// join bound in isolation).
export { boundJoinFailures as boundJoinFailuresForTest };

export { runDevelopTopological };
