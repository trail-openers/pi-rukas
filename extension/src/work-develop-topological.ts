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
  type DevelopRunState,
  makeRunOneWorkstream,
  runDependentWorkstreams,
} from "./work-develop-run.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { topologicalDispatchOrder } from "./work-driver-dep-scheduler.ts";
import { clearDispatch } from "./work-driver-resume.ts";
import { applySafetyNet, hasAnyWorktreeEvidence } from "./work-driver-safety-net.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

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
  const verdicts: Array<{ id: string; ok: boolean }> = [];
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
  // #753 — the worktrees that exist as part of THIS cycle, keyed by workstream
  // id. Seeded from pipelineState (the branch step's creations) so the #545
  // same-issue dirty scan in the dependent phase treats this cycle's own
  // worktrees as in-flight work, not as "leftover" — otherwise an independent
  // workstream's legitimate in-progress dirt would park the cycle on a false
  // positive (the #545 scan is unbounded within a cycle). The dependent phase
  // grows this as it creates worktrees.
  const inCycleWorktrees: string[] = [...Object.values(worktrees)];

  const independentCwds = independent.map((id) => worktrees[id] ?? ctx.repoRoot);
  const independentResults = await Promise.all(
    independent.map(async (id, i) => runOneWorkstream(id, independentCwds[i] ?? ctx.repoRoot)),
  );

  // #679 — a workstream is “blocked” for its dependents when its dispatch
  // failed OR when it produced NO commits ahead of its base (the case-2(c)
  // falsely-ok shape): building a dependent worktree on a dependency that
  // shipped nothing is the incoherent-tree failure this ticket fixes.
  const failedOrSkipped = new Set<string>();
  for (const r of independentResults) {
    if (!r.ok) failedOrSkipped.add(r.id);
  }
  // #753 — populate the dep-completion map: dependents wait on their DIRECT
  // dependency, so record the resolved fan-out time for every independent
  // workstream; the dependent phase records its own completion as it goes.
  for (const id of independent) depCompletedAtMap[id] = independentCompletedAt;
  for (const id of independent) {
    const cwd = worktrees[id] ?? ctx.repoRoot;
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
    next = appendEvent(clearDispatch(next, begun.jobId));
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        worktrees,
        workstreamBaseShas: { ...workstreamBaseShas, ...next.pipelineState.workstreamBaseShas },
      },
    };
    return next;
  }
  void independentResults;
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
    next = appendEvent(next, {
      kind: "branches-converged",
      step: "develop",
      verdicts,
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
      // verify is a DECOMPOSITION error (two workstreams edited the same
      // lines), not a verify failure: retrying the verify command cannot
      // fix it. Route it to its own cap so the operator sees "the work is
      // individually fine but the decomposition is incoherent" instead of
      // being told the verify failed. The evidence (which apply failed,
      // any preserved patch path) rides on the cap-hit's `evidence` field.
      const conflictFailure = gate.failures.find((f) =>
        /cherry-pick \/ apply conflict|could not combine the workstreams/.test(f),
      );
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
            ...(gate.flakeRecovered ? { retries: 1, recovered: true } : {}),
          },
        },
      };
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap,
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
        ...(conflictFailure || consolidationCreatedFailure
          ? { evidence: (conflictFailure ?? consolidationCreatedFailure) as string }
          : {}),
      });
    }
  }
  return next;
}

export { runDevelopTopological };
