/**
 * work-driver-branch-develop — Step 3 (branch) + Step 4 (develop) handlers.
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Branch creates
 * the worktree(s); develop fans a developer into each and runs the safety net
 * + verify gate (re-gated per-worktree by #679 task-evidence).
 */
import path from "node:path";
import { dispatchCore } from "./dispatch.ts";
import { execp as argvExecp } from "./lens-exec.ts";
import { trace } from "./trace.ts";
import { BranchAheadError, mechanizedBranchSetup } from "./work-driver-branch-mechanized.ts";
import {
  netTimeoutBranchFailure,
  parseWorktreesBlock,
  runBranchViaOpsDispatch,
} from "./work-driver-branch-ops.ts";
import { runBranchResiduePass } from "./work-driver-branch-residue.ts";
// #1093 — cycle-start-ref stamping runs under the single integration lock.
import { hasCaptureFailure, recordCycleStartRef } from "./work-driver-git.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { isNetGitTimeout } from "./work-driver-net-git.ts";
// #1016 — the argv-honouring executor: the develop path passes `argv` to every
// git call, and a shell-only exec would run bare `git` and read every check as
// unreadable (fail closed on every workstream).
import { execp } from "./work-driver-verify.ts";

export { parseWorktreesBlock };
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import { cachedIssueTitle } from "./work-driver-integrate.ts";
import { findOpenPrForIssue, prPreflightEnabled } from "./work-driver-pr-preflight.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";

import {
  greenWorkstreamsFromInterruptedDevelop,
  isInterruptedDevelop,
} from "./work-develop-greens.ts";
import { backupInterruptedWorktrees } from "./work-develop-resume-backup.ts";
import { type PreservedGreens, trustedPreservedGreens } from "./work-develop-retry.ts";
import { runDevelopTopological } from "./work-develop-topological.ts";
import { pendingFixes, runAdversarialFixPass } from "./work-driver-adversarial-fix.ts";
import { salvageKnownDirtyWorktrees } from "./work-driver-branch-salvage.ts";
import { applySafetyNet, hasAnyWorktreeEvidence } from "./work-driver-safety-net.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { makeWorktreeProvisionedEvent } from "./workflow-state-events-provision.ts";
import { type WorkEvent, type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";
import { DirtyWorktreeError, WorktreeScanError, gitErrorDetail } from "./worktree.ts";

/**
 * #1093 — stamp `pipelineState.startRef` (the checkout the cycle found) and
 * persist it BEFORE the branch step can move repoRoot. The driver calls this
 * just ahead of runBranch, not inside it: the step-boundary write only comes
 * after the whole step, so a crash inside the branch dispatch would lose the
 * ref with the checkout already moved. Written once; a resumed cycle keeps the
 * ref its first run captured.
 *
 * #1093 — the capture runs under the integration lock. A sibling group's
 * merged or handoff step moves repoRoot under that same lock, so an unlocked
 * read could record the SIBLING's feature branch as this cycle's start ref.
 * When the queue captured the ref once per invocation (`invocationStartRef`),
 * that value is stamped instead: the lock only orders reads, it cannot tell a
 * sibling's failed restore (repoRoot left on its branch) from the operator's.
 */
export async function stampCycleStartRef(ctx: CycleContext, state: WorkState): Promise<WorkState> {
  if (state.pipelineState.startRef) return state;
  // A failed capture on an earlier run is recorded in plumbReports; a resumed
  // cycle must not recapture (repoRoot may already be on the feature branch).
  if (hasCaptureFailure(state)) return state;
  if (ctx.invocationStartRef !== undefined) {
    const stamped = {
      ...state,
      pipelineState: { ...state.pipelineState, startRef: ctx.invocationStartRef },
    };
    await persistCycle(ctx, stamped);
    return stamped;
  }
  return withIntegrationLock(ctx.repoRoot, async () => {
    // argv-aware: the capture passes argv, which promisify(exec) silently drops.
    const stamped = await recordCycleStartRef(ctx.verifyExecFn ?? argvExecp, ctx.repoRoot, state);
    if (stamped !== state) await persistCycle(ctx, stamped);
    return stamped;
  });
}

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
  ctx: CycleContext,
  incoming: WorkState,
  now: number,
): Promise<WorkState> {
  const workstreamIds = Object.keys(incoming.pipelineState.workstreams ?? {});
  // Reassigned only when the mechanized path falls back, to carry its
  // plumb-report into the ops dispatch below.
  let base = incoming;
  const execFnPre = ctx.verifyExecFn ?? execp;
  // #545/#730 — the cycle's scratch dir, home of the dirty-worktree salvage
  // (used by both the residue pass below and the refusal path further down).
  const salvageScratch = scratchDir(ctx.repoRoot, ctx.issue);
  // #362 — pre-flight BEFORE the dispatch: `--restart` wipes the state file
  // but not GitHub, so without this the driver would open a second PR.
  let state: WorkState = incoming;
  if (prPreflightEnabled()) {
    const existing = await findOpenPrForIssue(execFnPre, ctx.repoRoot, ctx.issue);
    if (existing) {
      const withPr: WorkState = {
        ...state,
        pipelineState: {
          ...state.pipelineState,
          currentStep: "branch",
          existingPr: existing,
        },
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
  // #730 — same-issue worktree residue BEFORE the mechanized setup (the
  // exact #540/#724 restart collision): adopts a clean leftover at the
  // cycle's own target path, preserves (salvage patch + durable tag) any
  // dirty leftover, removes what it can, and records what it did. The
  // #475/#545 refusal is unchanged and still fires for residue this pass
  // could not resolve; salvageScratch is also the #545 refusal's home.
  state = await runBranchResiduePass(ctx, state, execFnPre, salvageScratch);
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
      let setup: Awaited<ReturnType<typeof mechanizedBranchSetup>>;
      try {
        setup = await mechanizedBranchSetup(
          execFnMech,
          ctx.repoRoot,
          ctx.issue,
          activeIssuesOf(state),
          workstreamIds,
          await cachedIssueTitle(state),
          dependsOnByWorkstream,
        );
      } catch (aheadErr) {
        // #844 — a local branch of the resolved name is AHEAD of the
        // freshly-fetched base (unpushed work of a live cycle, or a
        // diverged branch). The step halts with a dedicated cap naming the
        // branch and its ahead count — nothing is reset and NO ops
        // fallback (whose mainline guard would not catch this shape).
        if (aheadErr instanceof BranchAheadError) {
          const aheadLabel = aheadErr.aheadCount === null ? "unknown" : String(aheadErr.aheadCount);
          trace(
            `work-driver: branch step halted — local branch ${aheadErr.branchName} is ${aheadLabel === "unknown" ? "an unknown number of" : `${aheadLabel}`} commit(s) ahead of the fetched base; nothing was reset`,
          );
          const started = appendEvent(
            {
              ...state,
              pipelineState: { ...state.pipelineState, currentStep: "branch" },
            },
            { kind: "step-started", step: "branch", at: now },
          );
          return appendEvent(started, {
            kind: "cap-hit",
            at: Date.now(),
            cap: `branch-ahead:${aheadLabel}` as const,
            reviewRound: state.pipelineState.reviewRound,
            nextStep: "handoff",
            evidence: `${aheadErr.branchName} is ${aheadErr.aheadCount === null ? "an unknown number of" : `${aheadErr.aheadCount}`} commit(s) ahead of the fetched base (origin/<mainline>) — possible unpushed work of a live cycle (ahead count ${aheadLabel === "unknown" ? "unreadable — the ancestry probe failed, so the driver refused to reset on a guess" : `confirmed as ${aheadLabel}`})`,
          });
        }
        throw aheadErr;
      }
      // #844 — the reset of a stale local branch is recorded in the event
      // log (the recovery handle) so the audit trail carries the old tip
      // even if a later step fails.
      let baseState = state;
      if (setup.resetFromSha !== undefined) {
        baseState = appendEvent(baseState, {
          kind: "branch-reset",
          at: Date.now(),
          branch: setup.branchName,
          oldSha: setup.resetFromSha,
          newSha: setup.baseSha,
        });
      }
      const started = appendEvent(
        {
          ...baseState,
          pipelineState: { ...baseState.pipelineState, currentStep: "branch" },
        },
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
            makeWorktreeProvisionedEvent(id, cwd, pr.via, pr.problem, pr.hookFailed),
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
      if (isNetGitTimeout(err)) {
        trace(
          `work-driver: branch step failed on a network git timeout: ${err.message.slice(0, 200)}`,
        );
        return netTimeoutBranchFailure(state, err, now);
      }
      const errDetail = gitErrorDetail(err);
      // #475 — the ops fallback's branch prompt tells ops to
      // `git worktree remove --force` an existing worktree, so falling
      // back after a dirty-worktree refusal would destroy exactly the
      // work the guard just protected. Refusal goes to handoff via the
      // step-failed:branch cap. #1170 — an unreadable sibling listing is a
      // refusal too: the ops fallback would create the worktree unscanned.
      if (err instanceof DirtyWorktreeError || err instanceof WorktreeScanError) {
        trace(`work-driver: branch step refused — dirty worktree: ${err.message?.slice(0, 300)}`);
        const started = appendEvent(
          {
            ...state,
            pipelineState: { ...state.pipelineState, currentStep: "branch" },
          },
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
  try {
    return await runBranchViaOpsDispatch(ctx, base, workstreamIds, now);
  } catch (err) {
    if (isNetGitTimeout(err)) {
      trace(
        `work-driver: branch step failed on a network git timeout: ${err.message.slice(0, 200)}`,
      );
      return netTimeoutBranchFailure(base, err, now);
    }
    throw err;
  }
}

/**
 * Step 4 — Implementation.
 *
 * PR3 restored multi-workstream parallelism: N>1 workstreams fan out N
 * developers, each in its own worktree. #679 extends this to a
 * topological-dispatch order (independent parallel + dependent sequential)
 * and defers the dependent workstreams' worktree creation to after their
 * dependency commits (case 2(b)); both the core and the per-workstream
 * dispatch closure live in work-develop-run.ts.
 */
export async function runDevelop(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // #1114 — a develop step with adversarial fix requests pending is a FIX
  // PASS for those workstreams (work-driver-adversarial-fix.ts), not a fresh
  // implementation: same worktrees, same gates, findings in the prompt.
  const pendingFix = pendingFixes(state.eventLog);
  if (pendingFix.length > 0) return runAdversarialFixPass(ctx, state, pendingFix, now);
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
    ctx,
    next,
    "develop",
    "developer",
    ids.length > 1 ? `developer×${ids.length}` : "developer",
    Date.now(),
  );
  next = begun.state;
  // #1016 — crash-resume: workstreams that finished green before the crash
  // keep their worktree and commits; only the rest are re-dispatched.
  // A green without commits ahead of its base is re-dispatched, not kept.
  const baseFor = (id: string) =>
    state.pipelineState.workstreamBaseShas?.[id] ?? state.pipelineState.baseSha;
  const greens = await trustedPreservedGreens(greenWorkstreamsFromInterruptedDevelop(state), {
    execFn,
    worktrees: state.pipelineState.worktrees ?? {},
    baseFor,
  });
  // #1016 — save before re-dispatch: an interrupted develop may have left a
  // failed workstream's partial edits in its worktree. Save them to a patch
  // before the resumed fan-out can run the developer over them.
  const backup = isInterruptedDevelop(state)
    ? await backupInterruptedWorktrees({
        execFn,
        repoRoot: ctx.repoRoot,
        scratchAbs: scratchDir(ctx.repoRoot, ctx.issue),
        ids: ids.filter((id) => !greens.kept.has(id)),
        worktrees: state.pipelineState.worktrees ?? {},
        baseFor,
      })
    : { refused: {}, saved: {}, notes: [] };
  const preserved: PreservedGreens = {
    kept: greens.kept,
    notes: [
      ...greens.notes,
      ...Object.entries(backup.saved).map(
        ([id, p]) => `${id}: uncommitted work from the interrupted attempt saved to ${p}`,
      ),
      ...backup.notes,
    ],
    refused: backup.refused,
  };
  if (preserved.kept.size > 0) {
    trace(
      `work-driver: develop resumed — keeping green workstreams ${[...preserved.kept].join(", ")}`,
    );
  }
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
    preserved,
  );
}
