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
  );
  worktrees = wtResult.worktrees;
  workstreamBaseShas = wtResult.workstreamBaseShas;
  next = stateRef.current;
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
      const cap = conflictFailure ? "consolidated-verify-conflict" : "verify-failed:develop";
      trace(`work-driver: ${cap} — ${gate.failures.join(" | ")}`);
      next = {
        ...next,
        pipelineState: {
          ...next.pipelineState,
          verifyEvidence: { step: "develop", failures: gate.failures, at: Date.now() },
        },
      };
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap,
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
        ...(conflictFailure ? { evidence: conflictFailure } : {}),
      });
    }
  }
  return next;
}

export { runDevelopTopological };
