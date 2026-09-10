/**
 * work-driver-branch-develop — Step 3 (branch) + Step 4 (develop) handlers.
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Branch creates
 * the worktree(s); develop fans a developer into each and runs the safety net
 * + verify gate (re-gated per-worktree by #679 task-evidence).
 */
import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { buildMemoryBrief } from "./memory-brief.ts";
import { trace } from "./trace.ts";
import { mechanizedBranchSetup } from "./work-driver-branch-mechanized.ts";
import { parseWorktreesBlock, runBranchViaOpsDispatch } from "./work-driver-branch-ops.ts";
import { topologicalDispatchOrder } from "./work-driver-dep-scheduler.ts";

export { parseWorktreesBlock };
import type { DriverContext } from "./work-driver-context.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import { cachedIssueTitle } from "./work-driver-integrate.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { findOpenPrForIssue, prPreflightEnabled } from "./work-driver-pr-preflight.ts";
import {
  inlineDevelopPrompt,
  inlineSpeculativeExplorePrompt,
} from "./work-driver-prompts-early.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";

import {
  type DevelopRunState,
  makeRunOneWorkstream,
  runDependentWorkstreams,
} from "./work-develop-run.ts";
import { salvageKnownDirtyWorktrees } from "./work-driver-branch-salvage.ts";
import { applySafetyNet, hasAnyWorktreeEvidence } from "./work-driver-safety-net.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { makeWorktreeProvisionedEvent } from "./workflow-state-events-provision.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import { DirtyWorktreeError, gitErrorDetail } from "./worktree.ts";

const execp = promisify(exec);

/**
 * Step 3 — Setup: ops creates the feature branch + worktrees.
 *
 * The ops subagent enforces the branch-step safety preconditions:
 * clean working tree, fast-forward mainline, then create
 * `feature/issue-N-<brief>` branch. The driver stores the branch name in
 * pipelineState once the dispatch returns so subsequent steps can compose
 * worktree paths and the PR URL.
 *
 * #292 — branchName is resolved from git, NOT from the ops reply.
 * Pre-fix the driver parsed branchName from the ops reply via
 * parseBranchName and stored it verbatim. On live issue #277 the ops
 * subagent reported a branch name unrelated to the issue. Now:
 * `git rev-parse --abbrev-ref HEAD` is the source of truth. If the
 * reported name disagrees, a plumb-report is emitted.
 */
export async function runBranch(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const workstreamIds = Object.keys(state.pipelineState.workstreams ?? {});
  // Reassigned only when the mechanized path falls back, to carry its
  // plumb-report into the ops dispatch below.
  let base = state;
  const execFnPre = ctx.verifyExecFn ?? execp;
  // #362 — pre-flight BEFORE the dispatch: `--restart` wipes the state file
  // but not GitHub, so without this the driver would open a second PR.
  if (prPreflightEnabled()) {
    const existing = await findOpenPrForIssue(execFnPre, ctx.repoRoot, ctx.issue);
    if (existing) {
      const withPr: WorkState = {
        ...state,
        pipelineState: { ...state.pipelineState, currentStep: "branch", existingPr: existing },
      };
      return appendEvent(withPr, {
        kind: "cap-hit",
        at: now,
        cap: "existing-pr-detected",
        reviewRound: 0,
        nextStep: "handoff",
      });
    }
  }
  // #545 — a dirty leftover of the SAME issue is salvaged to the cycle's
  // scratch dir before the refusal. A salvage failure degrades to the
  // pre-#545 refusal text.
  const salvageScratch = scratchDir(ctx.repoRoot, ctx.issue);
  // #287 — mechanized, always-worktree branch setup. Development never
  // happens at repoRoot: every workstream gets a detached worktree. The LLM
  // ops dispatch below remains as the fallback for env variance (recovery,
  // not an opt-out).
  {
    const execFnMech = ctx.verifyExecFn ?? execp;
    try {
      // #679 case 2(b) — build the depends-on map from the plan's
      // workstreams so mechanizedBranchSetup can DEFER the dependent
      // workstreams (their worktrees are created in runDevelop, from the
      // dependency's post-commit SHA, not here at baseSha). For the N=1
      // default path this is `{}` (the default workstream cannot declare
      // depends-on), so the pre-#679 shape is byte-identical.
      const wsMap = state.pipelineState.workstreams ?? {};
      const dependsOnByWorkstream: Record<string, string[]> = {};
      for (const [id, ws] of Object.entries(wsMap)) {
        if (ws?.dependsOn && ws.dependsOn.length > 0) dependsOnByWorkstream[id] = ws.dependsOn;
      }
      const setup = await mechanizedBranchSetup(
        execFnMech,
        ctx.repoRoot,
        ctx.issue,
        activeIssuesOf(state),
        workstreamIds,
        await cachedIssueTitle(state),
        dependsOnByWorkstream,
      );
      const started = appendEvent(
        { ...state, pipelineState: { ...state.pipelineState, currentStep: "branch" } },
        { kind: "step-started", step: "branch", at: now },
      );
      // Via the shared builder (work-driver-events.ts): unique jobId —
      // the old inline literal "mechanized" appeared twice per fan-out
      // cycle, making jobId useless as a correlation key.
      const done = appendEvent(
        started,
        synthesizeDriverCompletion({
          step: "branch",
          label: "driver:branch",
          summary: `Mechanized branch setup: ${setup.branchName} @ ${setup.baseSha.slice(0, 8)} off origin/${setup.mainline}; ${Object.keys(setup.worktrees).length} worktree(s).`,
          startedAt: now,
          now: Date.now(),
        }),
      );
      // #536 — per-workstream provision event for targeted depsHint in verify-develop.
      let withProvisions = done;
      for (const [id, cwd] of Object.entries(setup.worktrees)) {
        const pr = setup.provisions[id];
        if (pr) {
          withProvisions = appendEvent(
            withProvisions,
            makeWorktreeProvisionedEvent(id, cwd, pr.via, pr.problem),
          );
        }
      }
      return {
        ...withProvisions,
        pipelineState: {
          ...withProvisions.pipelineState,
          branchName: setup.branchName,
          baseSha: setup.baseSha,
          worktrees: setup.worktrees,
          // #679 — record the per-workstream effective base as of the branch
          // step. Every independent workstream maps to the global baseSha;
          // dependent workstreams (deferred) are NOT in this map yet — their
          // entry is added by runDevelop at deferred-creation time, when the
          // dependency's post-commit SHA is known. Readers (applySafetyNet,
          // verifyDevelopOutcome) fall back to the global baseSha for any
          // workstream id absent from the map.
          workstreamBaseShas: setup.workstreamBaseShas,
        },
      };
    } catch (err) {
      // #545 — a NON-dirty mechanized failure used to fall back to the
      // ops dispatch with only a trace line and a bare `step-failed:branch`
      // cap downstream: no plumb report, no git stderr in the event log.
      // Plumb the actual git error BEFORE deciding the fallback.
      const errDetail = gitErrorDetail(err);
      // #475 — the ops fallback's branch prompt tells ops to
      // `git worktree remove --force` an existing worktree, so falling
      // back after a dirty-worktree refusal would destroy exactly the
      // work the guard just protected. Refusal goes to handoff via the
      // step-failed:branch cap.
      if (err instanceof DirtyWorktreeError) {
        trace(`work-driver: branch step refused — dirty worktree: ${err.message?.slice(0, 300)}`);
        const started = appendEvent(
          { ...state, pipelineState: { ...state.pipelineState, currentStep: "branch" } },
          { kind: "step-started", step: "branch", at: now },
        );
        // #545 — salvage the dirty worktrees this cycle ALREADY knows about
        // (state.pipelineState.worktrees, populated by a prior branch step —
        // the `--restart` shape: the state file survives the wipe, the
        // worktrees it created still do). The refusal below keeps each on
        // disk; the operator gets the salvage location in the plumb report.
        // The refused path itself is salvaged too when it belongs to this
        // cycle (name prefix `issue-<N>`), even though a crashed branch
        // step never recorded it in the state — `worktrees` is written only
        // after `worktreeCreate` succeeds for every workstream.
        const refusedPath = (err as { finding?: { path?: string } }).finding?.path;
        const salvageTargets = {
          ...(state.pipelineState.worktrees ?? {}),
          ...(refusedPath?.startsWith(path.join(ctx.repoRoot, ".worktrees", `issue-${ctx.issue}`))
            ? { refused: refusedPath }
            : {}),
        };
        const salvageNote = await salvageKnownDirtyWorktrees(
          execFnMech,
          salvageTargets,
          salvageScratch,
        ).catch((salvErr) => {
          trace(
            `work-driver: salvage failed (non-fatal): ${(salvErr as Error).message?.slice(0, 200)}`,
          );
          return "";
        });
        const withReport = {
          ...started,
          pipelineState: {
            ...started.pipelineState,
            plumbReports: [
              ...(started.pipelineState.plumbReports ?? []),
              {
                step: "branch" as const,
                role: "driver",
                body: `${err.message}${salvageNote ? `\n${salvageNote}` : ""}`,
                at: Date.now(),
              },
            ],
          },
        };
        return appendEvent(withReport, {
          kind: "cap-hit",
          at: Date.now(),
          cap: "step-failed:branch",
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff",
        });
      }
      trace(
        `work-driver: mechanized branch setup fell back to ops dispatch: ${errDetail.slice(0, 200)}`,
      );
      base = {
        ...appendEvent(base, {
          kind: "plumb-report",
          at: Date.now(),
          step: "branch",
          role: "driver",
          body: `Mechanized branch setup failed (git error: ${errDetail.slice(0, 300)}), falling back to the ops dispatch: ${(err as Error).message?.slice(0, 300)}`,
        }),
        pipelineState: {
          ...base.pipelineState,
          plumbReports: [
            ...(base.pipelineState.plumbReports ?? []),
            {
              step: "branch" as const,
              role: "driver",
              body: `Mechanized branch setup failed (git error: ${errDetail.slice(0, 300)})`,
              at: Date.now(),
            },
          ],
        },
      };
    }
  }
  return runBranchViaOpsDispatch(ctx, base, workstreamIds, now);
}

/**
 * Step 4 — Implementation.
 *
 * PR3 restored multi-workstream parallelism: N>1 workstreams fan out N
 * developers, each in its own worktree. #679 extends this to a
 * topological-dispatch order (independent parallel + dependent sequential)
 * and defers the dependent workstreams' worktree creation to after their
 * dependency commits (case 2(b)). The core lives in runDevelopTopological
 * (below); the per-workstream dispatch closure lives in work-develop-run.ts.
 */
export async function runDevelop(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const workstreams = state.pipelineState.workstreams ?? {};
  const ids = Object.keys(workstreams).length > 0 ? Object.keys(workstreams) : ["default"];
  // PR11 — thread the ACTIVE issue list (NEEDS_WORK subset after
  // explore) into developer + speculative-explore prompts. activeIssuesOf
  // falls back to [ctx.issue] for single-issue cycles.
  const activeIssues = activeIssuesOf(state);

  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "develop" },
  };
  next = appendEvent(next, { kind: "step-started", step: "develop", at: now });
  // Only emit branches-fanned-out for N>1 (N=1 stays terse in scrollback).
  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-fanned-out",
      step: "develop",
      workstreams: ids,
      at: now,
    });
  }

  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const execFn = ctx.verifyExecFn ?? execp;
  // #382 — write-ahead. `develop` is the longest-running step and the
  // biggest crash window. One marker for the whole step: resume
  // granularity is the step, and a half-finished fan-out is re-entered
  // wholesale.
  const begun = await beginDispatch(
    ctx.repoRoot,
    next,
    "develop",
    "developer",
    ids.length > 1 ? `developer×${ids.length}` : "developer",
    Date.now(),
  );
  next = begun.state;
  return runDevelopTopological(
    ctx,
    next,
    ids,
    workstreams,
    activeIssues,
    dispatch,
    execFn,
    now,
    begun.jobId,
  );
}

/** #679 — topological-dispatch core of runDevelop (see work-develop-run.ts). */
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
    if (!gate.ok) {
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

/**
 * #679 — one dependent workstream: skip-cascade check → resolve the
 * dependency's post-commit SHA → create the deferred worktree → dispatch.
 * A dependent whose dependency failed/was skipped is itself skipped (no
 * worktree, no dispatch) — recorded as `branch-completed` with `ok: false`
 * and a reason. No baseSha fallback (building on baseSha when the dependency
 * produced nothing is the incoherent-tree failure the ticket fixes).
 */
