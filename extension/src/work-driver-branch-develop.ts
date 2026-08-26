/**
 * work-driver-branch-develop — Step 3 (branch) + Step 4 (develop) handlers.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Grouped
 * together as natural pipeline-adjacent steps: branch creates the
 * worktree(s) develop then fans a developer into.
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { buildMemoryBrief } from "./memory-brief.ts";
import { trace } from "./trace.ts";
import { mechanizedBranchSetup } from "./work-driver-branch-mechanized.ts";
import { parseWorktreesBlock, runBranchViaOpsDispatch } from "./work-driver-branch-ops.ts";

export { parseWorktreesBlock };
import type { DriverContext } from "./work-driver-context.ts";
import { cachedIssueTitle } from "./work-driver-integrate.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { findOpenPrForIssue, prPreflightEnabled } from "./work-driver-pr-preflight.ts";
import {
  inlineDevelopPrompt,
  inlineSpeculativeExplorePrompt,
} from "./work-driver-prompts-early.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";

import { salvageKnownDirtyWorktrees } from "./work-driver-branch-salvage.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
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
 * #292 — branchName is resolved from git, NOT from the ops reply. Pre-fix
 * the driver parsed branchName from the ops reply via parseBranchName and
 * stored it verbatim. On live issue #277 the ops subagent reported a branch
 * name unrelated to the issue, and the real work was on a different branch.
 * Now: `git rev-parse --abbrev-ref HEAD` is the source of truth. If the
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
  // #362 — pre-flight BEFORE the dispatch. `--restart` wipes the state file
  // but not GitHub, so without this the driver rebuilds an issue that already
  // has an open PR and opens a second one (#358 orphaned by #359). Halting
  // here costs zero tokens; halting after develop costs a whole cycle.
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
  // scratch dir before the refusal (the driver already owns the scratch
  // lifecycle: cleaned on `merged`, kept on handoff for inspection). A
  // salvage failure degrades to the pre-#545 refusal text; the refusal
  // itself is unchanged — a dirty leftover always goes to handoff.
  const salvageScratch = scratchDir(ctx.repoRoot, ctx.issue);
  // #287 — mechanized, always-worktree branch setup. Development never
  // happens at repoRoot: every workstream (including the degenerate N=1
  // `default`) gets a detached worktree, and repoRoot is touched only by
  // `integrate()` at commit-pr. #393 removed the two knobs that used to gate
  // this — both restored the pre-#287 shape that swept stale repoRoot residue
  // into a merged PR. The LLM ops dispatch below remains as the fallback for
  // env variance, which is recovery, not an opt-out.
  {
    const execFnMech = ctx.verifyExecFn ?? execp;
    try {
      const setup = await mechanizedBranchSetup(
        execFnMech,
        ctx.repoRoot,
        ctx.issue,
        activeIssuesOf(state),
        workstreamIds,
        await cachedIssueTitle(state),
      );
      const started = appendEvent(
        { ...state, pipelineState: { ...state.pipelineState, currentStep: "branch" } },
        { kind: "step-started", step: "branch", at: now },
      );
      const done = appendEvent(started, {
        kind: "dispatch-completed",
        step: "branch",
        role: "driver",
        jobId: "mechanized",
        label: "driver:branch",
        ok: true,
        ms: 0,
        at: Date.now(),
        summary: `Mechanized branch setup: ${setup.branchName} @ ${setup.baseSha.slice(0, 8)} off origin/${setup.mainline}; ${Object.keys(setup.worktrees).length} worktree(s).`,
      });
      return {
        ...done,
        pipelineState: {
          ...done.pipelineState,
          branchName: setup.branchName,
          baseSha: setup.baseSha,
          worktrees: setup.worktrees,
        },
      };
    } catch (err) {
      // #545 — a NON-dirty mechanized failure used to fall back to the ops
      // dispatch with only a trace line and a bare `step-failed:branch` cap
      // downstream: no plumb report, no git stderr in the event log, and the
      // 3-second #540 abort had no WHY in the handoff. Plumb the actual git
      // error BEFORE deciding the fallback, so either outcome names the cause.
      const errDetail = gitErrorDetail(err);
      // #475 — the ops fallback's branch prompt tells ops to
      // `git worktree remove --force` an existing worktree, so falling back
      // after a dirty-worktree refusal would destroy exactly the work the
      // guard just protected. Refusal is a refusal: it goes to handoff via
      // the step-failed:branch cap, with the finding in a plumb report the
      // handoff comment renders.
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
 * PR3 restored multi-workstream parallelism (the "default to parallel"
 * doctrine PR #239 silently dropped). When Step 2
 * decomposed the issue into N>1 workstreams, this step fans out N
 * developers in parallel — each in its own worktree — via Promise.all
 * over driver-owned `dispatchCore` calls (the same pattern that
 * `runLensReview` uses for its 6 lens children).
 *
 * For N=1 (the `default` workstream synthesised by Step 2), the existing
 * `runSingleDispatch` path runs unchanged — N=1 isn't a special case,
 * just the degenerate one. Both paths populate the SAME event log shape;
 * downstream Steps 5 (adversarial) and 7 (lens-review) see a single
 * coherent diff via `fetchDiff` whether N=1 or N>1.
 *
 * Partial failures don't abort the join: each branch is try/catch'd
 * inside the `Promise.all`. Adversarial sees the aggregate; the
 * `branches-converged` event records which branches succeeded.
 */
export async function runDevelop(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const ids =
    Object.keys(state.pipelineState.workstreams ?? {}).length > 0
      ? Object.keys(state.pipelineState.workstreams ?? {})
      : ["default"];
  // PR11 — thread the ACTIVE issue list (NEEDS_WORK subset after
  // explore) into developer + speculative-explore prompts, not the
  // primary cycle issue. activeIssuesOf falls back to [ctx.issue] for
  // single-issue cycles so existing behaviour is preserved.
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
  const scratchAbs = scratchDir(ctx.repoRoot, ctx.issue);
  // Speculative explore alongside each developer — OPT-IN. It hands findings over through a
  // scratch file the developer prompt names, and measured over a day of live cycles that hand-off
  // never once completed: the developer reads the path 3-7s in, the file landed 14-130s later,
  // every access ENOENT — 397k-956k tokens per child that nothing consumed. Nor was it free, as
  // this comment used to claim: `allSettled` below resolves at max(developer, speculative), and it
  // won 6 of 23 measured branches (1425s, 1252s of it on one). Kept because awaiting it and
  // inlining its findings into the developer prompt — no file, no race — is worth measuring.
  const speculativeOn = process.env.PI_ENSEMBLE_SPECULATIVE_EXPLORE === "1";
  const verdicts: Array<{ id: string; ok: boolean }> = [];
  const branchEvents: typeof next.eventLog = [];
  // #382 — write-ahead. `develop` is the longest-running step in the cycle
  // and the biggest crash window; covering only `runSingleDispatch` (which
  // this fan-out does not use) would have left exactly that window uncovered.
  // One marker for the whole step: resume granularity is the step, and a
  // half-finished fan-out is re-entered wholesale.
  const begun = await beginDispatch(
    ctx.repoRoot,
    next,
    "develop",
    "developer",
    ids.length > 1 ? `developer×${ids.length}` : "developer",
    Date.now(),
  );
  next = begun.state;
  const results = await Promise.all(
    ids.map(async (id) => {
      const ws = state.pipelineState.workstreams?.[id];
      const cwd = state.pipelineState.worktrees?.[id] ?? ctx.repoRoot;
      const startedAt = Date.now();
      const developerLabel = ids.length > 1 ? `developer[${id}]` : "developer";
      const speculativeContextPath = path.join(scratchAbs, `speculative-${id}.md`);
      try {
        // Fire developer + (optional) speculative explore CONCURRENTLY;
        // allSettled so one failing does not abort the other. On the race
        // that makes the scratch hand-off useless, see the knob above.
        // #422 — prior memory about the files this workstream will touch.
        // Never fatal: any vipune problem degrades to an empty brief.
        const brief = await buildMemoryBrief(ws?.paths ?? [], {
          cwd: ctx.repoRoot,
          timeoutMs: 8000,
        });
        next = appendEvent(next, {
          kind: "memory-inject",
          at: Date.now(),
          step: "develop",
          queries: brief.queries,
          hits: brief.hits.length,
          emptyBrief: brief.emptyBrief,
          ids: brief.hits.map((h: { id: string }) => h.id),
        });

        const [developerSettled, speculativeSettled] = await Promise.allSettled([
          dispatch(
            ctx.pi,
            {
              role: "developer",
              prompt: inlineDevelopPrompt(
                activeIssues,
                scratchAbs,
                ws,
                ids.length > 1 ? id : undefined,
                speculativeOn ? speculativeContextPath : undefined,
                brief.text,
              ),
              cwd,
            },
            { label: developerLabel },
          ),
          speculativeOn
            ? dispatch(
                ctx.pi,
                {
                  role: "explore",
                  prompt: inlineSpeculativeExplorePrompt(
                    activeIssues,
                    ws,
                    speculativeContextPath,
                    scratchAbs,
                  ),
                  cwd,
                },
                { label: ids.length > 1 ? `explore:speculative[${id}]` : "explore:speculative" },
              )
            : Promise.resolve(null),
        ]);
        // Record the speculative outcome (best-effort observability;
        // failure is non-fatal — the developer ran on whatever context
        // Step 1's explore + the scratch file provided).
        if (speculativeSettled.status === "fulfilled" && speculativeSettled.value !== null) {
          const specEvent = await buildCompletionEvent(
            ctx,
            "develop",
            "explore",
            ids.length > 1 ? `explore:speculative[${id}]` : "explore:speculative",
            speculativeSettled.value,
          );
          branchEvents.push(specEvent);
        } else if (speculativeSettled.status === "rejected") {
          trace(
            `work-driver: speculative explore for workstream ${id} threw: ${(speculativeSettled.reason as Error).message?.slice(-200)}`,
          );
        }
        if (developerSettled.status === "rejected") {
          throw developerSettled.reason;
        }
        const res = developerSettled.value;
        const ok = res.ok && !res.errorStop;
        const completionEvent = await buildCompletionEvent(
          ctx,
          "develop",
          "developer",
          developerLabel,
          res,
        );
        branchEvents.push(completionEvent);
        if (ids.length > 1) {
          branchEvents.push({
            kind: "branch-completed",
            step: "develop",
            workstreamId: id,
            ok,
            ms: Date.now() - startedAt,
            at: Date.now(),
          });
        }
        verdicts.push({ id, ok });
        return { id, ok };
      } catch (err) {
        const errMsg = (err as Error).message?.slice(0, 200);
        branchEvents.push({
          kind: "dispatch-failed",
          step: "develop",
          role: "developer",
          jobId: "unknown",
          label: developerLabel,
          ms: Date.now() - startedAt,
          at: Date.now(),
          errorTail: errMsg,
        });
        if (ids.length > 1) {
          branchEvents.push({
            kind: "branch-completed",
            step: "develop",
            workstreamId: id,
            ok: false,
            ms: Date.now() - startedAt,
            at: Date.now(),
            error: errMsg,
          });
        }
        verdicts.push({ id, ok: false });
        return { id, ok: false };
      }
    }),
  );
  void results;
  next = appendEvent(clearDispatch(next, begun.jobId), ...branchEvents);
  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-converged",
      step: "develop",
      verdicts,
      at: Date.now(),
    });
  }
  // PR17 — outcome verification gate. Only when every branch claims
  // success (failed branches already route through the dispatch-failed
  // HALT machinery); the gate exists to catch the OTHER case, where all
  // claims are green but the evidence isn't: no diff anywhere, or the
  // project's verify command (typecheck/test) fails on the produced
  // code. Catching a broken build here saves the full adversarial →
  // lens → CI round-trip that would otherwise discover it post-PR.
  if (verdicts.every((v) => v.ok)) {
    const gate = await verifyStepOutcome(ctx, next, "develop");
    if (!gate.ok) {
      trace(`work-driver: verify-failed:develop — ${gate.failures.join(" | ")}`);
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
        cap: "verify-failed:develop",
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
  }
  return next;
}
