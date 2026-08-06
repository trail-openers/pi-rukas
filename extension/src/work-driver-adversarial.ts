/**
 * work-driver-adversarial — Step 5 (adversarial gate) handler.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Fans out
 * one `runAdversarialLoop` call per workstream, aggregates the verdict,
 * and — on approval following a lens-fix round — commits the fix via
 * work-driver-lens.ts's `commitLensFixChanges`.
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { runAdversarialLoop } from "./adversarial.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { alwaysWorktreeEnabled } from "./work-driver-branch-mechanized.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { fetchDiff } from "./work-driver-diff.ts";
import { integrate } from "./work-driver-integrate.ts";
import { commitLensFixChanges } from "./work-driver-lens.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import type { ExecFn } from "./worktree.ts";

import { buildCompletionEvent } from "./work-driver-merged.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * #287 Part C — re-integrate a lens-fix made in a worktree.
 *
 * Mirrors `commitLensFixChanges`'s return shape so the caller's error and
 * push handling is unchanged, but routes through `integrate()` in "followup"
 * mode: the worktree's new diff is applied onto the feature branch at
 * repoRoot as an additional commit, then pushed, so the next lens-review
 * round and CI both see it.
 */
async function integrateLensFix(
  execFn: ExecFn,
  ctx: DriverContext,
  ps: PipelineState,
  worktrees: Record<string, string>,
): Promise<{ committed: boolean; error?: string; pushed?: boolean }> {
  const branchName = ps.branchName;
  if (!branchName) return { committed: false, error: "no branch name recorded" };
  const round = ps.reviewRound;
  const res = await integrate(execFn, {
    repoRoot: ctx.repoRoot,
    branchName,
    worktrees,
    scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
    commitTitle: `fix(lens): round ${round} review findings`,
    commitBody: `Addresses six-pass review findings from round ${round}.`,
    mode: "followup",
  });
  if (!res.ok) return { committed: false, error: res.reason };
  if (res.empty) return { committed: false };
  return { committed: true, pushed: true };
}

/** PR8 — extract round count from adversarial_loop's reply text. */
function parseAdversarialRounds(text: string): number {
  if (text.includes("after round 1")) return 1;
  if (text.includes("after round 2")) return 2;
  return 3;
}

/**
 * Step 5 — Adversarial gate.
 *
 * Calls `runAdversarialLoop` directly (exported from adversarial.ts). The
 * loop does its own 3-round internal cycle; the driver wraps the whole
 * thing in one dispatch event and routes on the synthesized verdict in the
 * result text.
 *
 * The driver-owned adversarial dispatch goes through async-jobs's startJob
 * with `ownerKind:"driver"` + `skipDeck:true` so the per-round dispatch
 * deck entries owned by `runAdversarialLoop` remain the user-visible UI.
 * No double-deck.
 */
export async function runAdversarial(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // PR8 — adversarial is the developer's tight-loop reviewer; it belongs
  // INSIDE each workstream's worktree, not on a merged fanout diff. The
  // pre-PR8 single-dispatch path computed the diff via fetchAllDiffs
  // (per-workstream sections concatenated with `## workstream:` headers)
  // and routed adversarial_loop's internal fix-developers to a single cwd.
  // For N>1 this caused two failures empirically (/work 553 2026-06-24):
  //   1. Reviewer flagged phantom CRITICALs that were cross-workstream
  //      merge artifacts (e.g., "uses undefined setView" — defined in
  //      sibling workstream's diff fragment).
  //   2. Internal fix-loop's developer dispatched into ONE worktree,
  //      fragmenting state further across the others — the loop spun 3
  //      rounds chasing phantoms.
  // PR8 fans out adversarial per workstream: N parallel adversarial_loop
  // runs, each scoped to one worktree's diff + cwd. Mirrors the develop
  // fanout structure (PR3). Aggregated verdict is the conjunction —
  // any per-workstream rejection routes to handoff via the existing
  // adversarial-rejected + cap-hit pattern.
  const ids =
    Object.keys(state.pipelineState.workstreams ?? {}).length > 0
      ? Object.keys(state.pipelineState.workstreams ?? {})
      : ["default"];

  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "adversarial" },
  };
  next = appendEvent(next, { kind: "step-started", step: "adversarial", at: now });
  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-fanned-out",
      step: "adversarial",
      workstreams: ids,
      at: now,
    });
  }

  type Outcome = {
    id: string;
    ok: boolean;
    rounds: number;
    /** #298 — true when the loop died on infrastructure (no verdict exists). */
    infra?: boolean;
    rejectionText?: string;
    completionEvent?: WorkEvent;
    failureEvent?: WorkEvent;
    branchEvent?: WorkEvent;
  };
  const outcomes: Outcome[] = await Promise.all(
    ids.map(async (id): Promise<Outcome> => {
      const cwd = state.pipelineState.worktrees?.[id] ?? ctx.repoRoot;
      const label = ids.length > 1 ? `adversarial[${id}]` : "adversarial_loop";
      const startedAt = Date.now();
      const orchestratorJobId = makeRunId();
      // Per-workstream diff: a single `git diff HEAD` from this worktree.
      // Coherent because it captures exactly what ONE developer wrote on
      // ONE branch. The cross-workstream merge happens later in
      // commit-pr where ops integrates the per-workstream branches; this
      // adversarial pass gates each workstream independently.
      const diff = await fetchDiff(cwd);

      // #286 — empty-diff short-circuit. A full adversarial reviewer spawn
      // on an empty diff is pure waste (transcript-verified on lantern
      // 2026-07-27: one spawn concluded "treat the empty diff as a
      // legitimate no-op" after burning a complete review cycle). Lens
      // review already has this guard (PR6); adversarial didn't. The
      // PR17 hollow-diff develop gate fires BEFORE adversarial, so
      // reaching here with all-empty diffs means a resumed/edge-case
      // cycle — which is fine, the skip is the correct response.
      const emptySkipDisabled = process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP === "0";
      if (!emptySkipDisabled && !diff.trim()) {
        trace(`work-driver: adversarial[${id}] skipped — empty diff`);
        return {
          id,
          ok: true,
          rounds: 0,
          completionEvent: {
            kind: "adversarial-skipped-empty-diff",
            at: Date.now(),
            workstreamId: id,
          },
          branchEvent:
            ids.length > 1
              ? {
                  kind: "branch-completed",
                  step: "adversarial",
                  workstreamId: id,
                  ok: true,
                  ms: Date.now() - startedAt,
                  at: Date.now(),
                }
              : undefined,
        } as Outcome;
      }

      const loopFn = ctx.adversarialLoopFn ?? runAdversarialLoop;
      let result: DispatchResult;
      try {
        result = await loopFn(
          {
            diff,
            context:
              ids.length > 1
                ? `/work issue #${ctx.issue}: gating diff for workstream "${id}" before commit (Step 5).`
                : `/work issue #${ctx.issue}: gating diff before commit (Step 5).`,
            workCwd: cwd,
          },
          // No AbortController plumbing in v1 — spawn-level timeouts
          // in spawn.ts (per-role) bound the work.
          new AbortController().signal,
          orchestratorJobId,
        );
      } catch (err) {
        const errMsg = (err as Error).message?.slice(-200);
        return {
          id,
          ok: false,
          rounds: 0,
          failureEvent: {
            kind: "dispatch-failed",
            step: "adversarial",
            role: "adversarial-loop",
            jobId: orchestratorJobId,
            label,
            ms: Date.now() - startedAt,
            at: Date.now(),
            errorTail: errMsg,
          },
          branchEvent:
            ids.length > 1
              ? {
                  kind: "branch-completed",
                  step: "adversarial",
                  workstreamId: id,
                  ok: false,
                  ms: Date.now() - startedAt,
                  at: Date.now(),
                  error: errMsg,
                }
              : undefined,
        };
      }
      const completionEvent = await buildCompletionEvent(
        ctx,
        "adversarial",
        "adversarial-loop",
        label,
        // #298 — a REJECTED verdict is a COMPLETED review, not a dispatch
        // failure. Pre-#298 the loop's exitCode=1 recorded the verdict as
        // dispatch-failed with the operator escalation menu as errorTail
        // (verified in lantern 553.json / pi-ensemble 277.json).
        result.loopOutcome === "rejected" ? { ...result, ok: true, exitCode: 0 } : result,
      );
      const ok = result.ok && !result.errorStop;
      const rounds = parseAdversarialRounds(result.text);
      return {
        id,
        ok,
        rounds,
        infra: !ok && result.loopOutcome === "infra-failure",
        rejectionText: ok ? undefined : result.text,
        completionEvent,
        branchEvent:
          ids.length > 1
            ? {
                kind: "branch-completed",
                step: "adversarial",
                workstreamId: id,
                ok,
                ms: Date.now() - startedAt,
                at: Date.now(),
              }
            : undefined,
      };
    }),
  );

  // Append per-workstream events in deterministic order (dispatch-completed
  // / dispatch-failed, then branch-completed for N>1).
  const events: WorkEvent[] = [];
  for (const o of outcomes) {
    if (o.completionEvent) events.push(o.completionEvent);
    if (o.failureEvent) events.push(o.failureEvent);
    if (o.branchEvent) events.push(o.branchEvent);
  }
  next = appendEvent(next, ...events);

  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-converged",
      step: "adversarial",
      verdicts: outcomes.map((o) => ({ id: o.id, ok: o.ok })),
      at: Date.now(),
    });
  }

  // Aggregate verdict. ALL approved → adversarial-approved (nextStep routes
  // to commit-pr). ANY rejected VERDICT → adversarial-rejected + cap-hit
  // (nextStep routes to handoff via the cap-hit). #298: failures that are
  // PURELY infrastructure (no verdict exists) append NO verdict events —
  // the dispatch-failed event stays the eventLog tail so the halt-cascade
  // router's RETRY_ONCE branch re-runs the step (pre-#298 the synthesized
  // cap-hit tail made that retry branch unreachable and every loop infra
  // failure went straight to handoff).
  const maxRounds = outcomes.reduce((acc, o) => Math.max(acc, o.rounds), 0);
  const aggregateJobId = makeRunId();
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) {
    next = appendEvent(next, {
      kind: "adversarial-approved",
      at: Date.now(),
      jobId: aggregateJobId,
      rounds: maxRounds,
    });

    // Issue #305 — commit lens-fix changes AFTER adversarial approves.
    // runLensFix leaves fix uncommitted in the working tree so adversarial
    // can review it via fetchDiff (git diff HEAD). Only commit on approval
    // so rejected fixes stay visible for inspection in handoff.
    //
    // The commit happens at ctx.repoRoot (consolidated after commit-pr) for
    // both N=1 and N>1 cycles. workstreams/ids reflect the pre-consolidation
    // state and are not used to gate this path.
    if (state.pipelineState.lastCompletedStep === "lens-fix") {
      const execFn = ctx.verifyExecFn ?? execp;
      const psFix = state.pipelineState;
      const fixWorktrees = psFix.worktrees ?? {};
      const inWorktree =
        alwaysWorktreeEnabled() &&
        Object.values(fixWorktrees).some((p) => path.resolve(p) !== path.resolve(ctx.repoRoot));
      // #287 — lens-fix runs in the WORKTREE (work-driver-lens.ts picks
      // `worktrees.default` as its cwd), so committing at repoRoot found a
      // clean tree and silently skipped: the fix never reached the PR. Pull
      // the worktree's new diff onto the branch through the same integration
      // path commit-pr uses, as a follow-up commit.
      const result = inWorktree
        ? await integrateLensFix(execFn, ctx, psFix, fixWorktrees)
        : await commitLensFixChanges(ctx.repoRoot, psFix.reviewRound, execFn);
      if (result.error) {
        // Surface git failures as plumb-report so the operator can intervene.
        // Record in pipelineState.plumbReports instead of event log so the
        // tail remains "adversarial-approved" and nextStep() routes correctly.
        next.pipelineState.plumbReports.push({
          step: "adversarial",
          role: "driver",
          body: `lens-fix ${result.error}`,
          at: Date.now(),
        });
      }
      // `integrate()` already pushed; only the legacy repoRoot path needs this.
      if (result.committed && !result.pushed) {
        // Push the commit so the remote branch (and PR) are updated for
        // the next lens-review round and CI.
        try {
          await execFn("git push origin HEAD -q", { cwd: ctx.repoRoot, maxBuffer: 64 * 1024 });
        } catch (err) {
          const errMsg = `lens-fix push failed (non-blocking): ${(err as Error).message?.slice(0, 200)}`;
          trace(`work-driver: ${errMsg}`);
          // Surface as plumb-report so the operator sees it in handoff.
          // Record in pipelineState.plumbReports instead of event log so the
          // tail remains "adversarial-approved" and nextStep() routes correctly.
          next.pipelineState.plumbReports.push({
            step: "adversarial",
            role: "driver",
            body: errMsg,
            at: Date.now(),
          });
        }
      }
    }
  } else if (failed.every((o) => o.infra) && ids.length === 1) {
    // N>1 keeps the legacy aggregate below: its tail is branches-converged,
    // which the RETRY_ONCE router doesn't intercept, so dropping the verdict
    // events there would strand the cycle instead of retrying it.
    trace(
      "work-driver: adversarial loop infrastructure failure — leaving dispatch-failed tail for RETRY_ONCE router",
    );
  } else {
    // Concatenate per-workstream rejection text (or dispatch-failure
    // marker) into findings so the handoff renderer surfaces all of them.
    const findings = failed
      .map((o) => {
        const tag = ids.length > 1 ? `[workstream ${o.id}] ` : "";
        return `${tag}${o.rejectionText ?? "(dispatch failed — see dispatch-failed event)"}`;
      })
      .join("\n\n---\n\n");
    next = appendEvent(
      next,
      {
        kind: "adversarial-rejected",
        at: Date.now(),
        jobId: aggregateJobId,
        rounds: maxRounds || 3,
        findings,
      },
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: "adversarial-loop",
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      },
    );
  }

  return next;
}
