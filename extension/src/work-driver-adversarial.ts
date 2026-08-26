/**
 * work-driver-adversarial — Step 5 (adversarial gate) handler.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Fans out
 * one `runAdversarialLoop` call per workstream, aggregates the verdict,
 * and — on approval following a lens-fix round — commits the fix via
 * work-driver-lens.ts's `commitLensFixChanges`.
 *
 * #492 — when a lens-fix never reaches the branch, the cap-hit carries the
 * CAUSE ("no diff produced" vs "a diff existed but integration failed")
 * and the git evidence that establishes it, plus the worktree inspected.
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import { capHitForCapKill } from "./work-driver-adversarial-capkill.ts";
import { fanOutAdversarial } from "./work-driver-adversarial-fanout.ts";
import { reentryPassBatchSpan } from "./work-driver-adversarial-reentry.ts";
import {
  ADVERSARIAL_PER_WS_MAX_RETRIES,
  type AdversarialOutcome,
} from "./work-driver-adversarial-types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { integrate, withIntegrationLock } from "./work-driver-integrate.ts";
import { commitLensFixChanges, lensWorktree } from "./work-driver-lens.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

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
  const res = await withIntegrationLock(ctx.repoRoot, () =>
    integrate(execFn, {
      repoRoot: ctx.repoRoot,
      branchName,
      worktrees,
      scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
      commitTitle: `fix(lens): round ${round} review findings`,
      commitBody: `Addresses six-pass review findings from round ${round}.`,
      mode: "followup",
    }),
  );
  if (!res.ok) return { committed: false, error: res.reason };
  if (res.empty) return { committed: false };
  return { committed: true, pushed: true };
}

/**
 * Step 5 — Adversarial gate. Fans out one `runAdversarialLoop` per
 * workstream (each scoped to one worktree's diff + cwd), aggregates the
 * verdict, and — on approval following a lens-fix round — commits the fix.
 */
export async function runAdversarial(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // PR8 — adversarial belongs INSIDE each workstream's worktree, not on a
  // merged fanout diff. Fans out one loop per workstream (N parallel) and
  // aggregates: any per-workstream rejection routes to handoff.
  const ids =
    Object.keys(state.pipelineState.workstreams ?? {}).length > 0
      ? Object.keys(state.pipelineState.workstreams ?? {})
      : ["default"];

  // #486 — re-entry after an infra retry: only workstreams whose last
  // outcome was NO VERDICT (infra-failure / dispatch-failed) re-run; a
  // workstream that produced a verdict is final.
  const priorOutcomes = new Map<string, string>();
  for (const e of state.eventLog) {
    if (e.kind === "adversarial-workstream-outcome") {
      priorOutcomes.set(e.workstreamId, e.outcome);
    }
  }
  const priorHadInfraFailure = [...priorOutcomes.values()].some((o) =>
    ["infra-failure", "dispatch-failed"].includes(o),
  );
  // #485/#486 — the previous pass's per-workstream batch span (R1 splice),
  // captured on the ORIGINAL event log (the fan-out clobbers `currentStep`).
  const priorBatchSpan = priorHadInfraFailure ? reentryPassBatchSpan(state.eventLog) : null;
  const retries = state.pipelineState.adversarialTransientRetries ?? {};
  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "adversarial" },
  };
  // The re-emitted `step-started` / `branches-fanned-out` header marks the
  // boundary of a fresh pass in the log; the re-entry pass does NOT
  // re-emit them: re-emitting puts them outside the spliced span and a
  // parked re-entry has to drop them again, which is what this pass's
  // records-vs-header accounting exists for. `step-started` is
  // informational (nothing routes on it); the re-entry pass's events are
  // self-describing (they carry `step: "adversarial"`).
  if (!priorHadInfraFailure) {
    next = appendEvent(next, { kind: "step-started", step: "adversarial", at: now });
    if (ids.length > 1) {
      next = appendEvent(next, {
        kind: "branches-fanned-out",
        step: "adversarial",
        workstreams: ids,
        at: now,
      });
    }
  }

  // #485/#486 — the per-workstream fan-out (loop invocation, per-round
  // verdict records, per-workstream infra retry) lives in the leaf module
  // work-driver-adversarial-fanout.ts (AGENTS.md §12); this handler
  // aggregates its outcomes into the verdict events below.
  const {
    next: fannedNext,
    outcomes,
    parked,
    parkedInfra,
  } = await fanOutAdversarial(ctx, next, ids, priorOutcomes, priorHadInfraFailure, priorBatchSpan);
  next = fannedNext;
  if (parked) {
    next = appendEvent(next, {
      kind: "cap-hit",
      at: now,
      cap: "adversarial-infra-failure",
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
    });
    return next;
  }
  if (parkedInfra) {
    // #486 — a FIRST-pass workstream exhausted its per-workstream budget and
    // never produced a verdict. A permanent infra failure is NOT a rejection;
    // park with the distinct cap, siblings' outcomes in the event log.
    const infraShortfall = outcomes.filter((o) => o.infra || o.threw);
    const names = infraShortfall.map((o) => o.id).join(", ");
    trace(
      `work-driver: adversarial per-workstream retry budget exhausted on first pass for [${names}] — parking`,
    );
    // #543 — F4(g): a cap kill (loop / token-budget) parks with its own
    // fixed-literal cap INSTEAD of the generic infra cap. The two are
    // distinct events; the fixed literal (no role suffix) + role field is
    // what F4(f) requires.
    const capKill = infraShortfall
      .map((o) => capHitForCapKill(o, state.pipelineState.reviewRound))
      .find(Boolean);
    if (capKill) {
      next = appendEvent(next, capKill.event);
      if (capKill.evidence) {
        next = {
          ...next,
          pipelineState: { ...next.pipelineState, capEvidence: capKill.evidence },
        };
      }
      return next;
    }
    const noVerdict = new Set(infraShortfall.map((o) => o.id));
    const rejectedReal = outcomes.filter((o) => !o.ok && !noVerdict.has(o.id));
    const maxRounds = outcomes.reduce((acc, o) => Math.max(acc, o.rounds), 0);
    const rejectedFindings = rejectedReal
      .map((o) => {
        const tag = ids.length > 1 ? `[workstream ${o.id}] ` : "";
        return `${tag}${o.rejectionText ?? "(see dispatch-failed event)"}`;
      })
      .join("\n\n---\n\n");
    const shortfallFindings = infraShortfall
      .map(
        () =>
          "(never produced a verdict — infrastructure failure, NOT a review rejection; see dispatch-failed event)",
      )
      .join("\n\n---\n\n");
    const findings = [rejectedFindings, shortfallFindings].filter(Boolean).join("\n\n---\n\n");
    next = appendEvent(
      next,
      ...(rejectedReal.length > 0
        ? [
            {
              kind: "adversarial-rejected" as const,
              at: Date.now(),
              jobId: makeRunId(),
              rounds: maxRounds,
              findings,
            },
          ]
        : []),
      {
        kind: "cap-hit" as const,
        at: Date.now(),
        cap:
          rejectedReal.length > 0
            ? ("adversarial-loop" as const)
            : ("adversarial-infra-failure" as const),
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff" as const,
      },
    );
    return next;
  }

  // Aggregate verdict. ALL approved → adversarial-approved (nextStep routes
  // to commit-pr). ANY rejected VERDICT → adversarial-rejected + cap-hit
  // (nextStep routes to handoff via the cap-hit). #298: failures that are
  // PURELY infrastructure (no verdict exists) append NO verdict events —
  // the dispatch-failed event stays the eventLog tail so the halt-cascade
  // router's RETRY_ONCE branch re-runs the step.
  const maxRounds = outcomes.reduce((acc, o) => Math.max(acc, o.rounds), 0);
  const aggregateJobId = makeRunId();
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) {
    // #486 — non-blocking findings survive the pass. `PASSED WITH FINDINGS`
    // is not `APPROVED`, and the difference has to reach the PR and the
    // lens gate. They are CARRIED in the verdict event itself: the PR body
    // (adversarial-findings.ts:carriedAdversarialFindings) reads `findings`
    // off the latest `adversarial-approved` and renders undefined when the
    // field is absent, so dropping the field would silently discard them.
    const carried = outcomes
      .map((o) => (o.passFindings?.trim() ? `### ${o.id}\n\n${o.passFindings.trim()}` : ""))
      .filter(Boolean)
      .join("\n\n---\n\n");
    next = appendEvent(next, {
      kind: "adversarial-approved",
      at: Date.now(),
      jobId: aggregateJobId,
      rounds: maxRounds,
      ...(carried ? { findings: carried } : {}),
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
      // #287 — development always happens in a worktree, so this is
      // normally true; defensive read of the actual worktree map.
      const inWorktree = Object.values(fixWorktrees).some(
        (p) => path.resolve(p) !== path.resolve(ctx.repoRoot),
      );
      // #287 — lens-fix runs in the WORKTREE (work-driver-lens.ts picks
      // `worktrees.default` as its cwd), so committing at repoRoot found a
      // clean tree and silently skipped: the fix never reached the PR. Pull
      // the worktree's new diff onto the branch through the same integration
      // path commit-pr uses, as a follow-up commit.
      const result = inWorktree
        ? await integrateLensFix(execFn, ctx, psFix, fixWorktrees)
        : await commitLensFixChanges(ctx.repoRoot, psFix.reviewRound, execFn);
      if (!result.committed) {
        // The fix did not reach the branch. #492 — the cause (no diff vs
        // integration failed) is established with git and carried on the
        // cap-hit itself; the next round would re-read an unchanged branch
        // and re-report identical findings, so halt and say why.
        const fixTree = inWorktree ? lensWorktree(ctx, state) : ctx.repoRoot;
        const cause = result.error
          ? `a diff existed but staging or integration failed (${result.error})`
          : "the fixer produced no diff — the inspected worktree was clean";
        if (result.error) {
          // The structural-failure half: a diff existed, and it may still
          // be sitting in the worktree — it deserves a plumb-report.
          next.pipelineState.plumbReports.push({
            step: "adversarial",
            role: "driver",
            body: `lens-fix ${cause} — worktree inspected: ${fixTree}`,
            at: Date.now(),
          });
        }
        // Establish the no-diff classification with git rather than
        // asserting it, and name the tree we checked — the #448 cwd defect
        // was exactly "we looked in the wrong tree".
        let evidence = result.error ?? "";
        if (!evidence) {
          try {
            const { stdout: statusOut } = await execFn("git status --porcelain", {
              cwd: fixTree,
              maxBuffer: 64 * 1024,
            });
            evidence = statusOut.trim()
              ? `git status --porcelain at ${fixTree} reported entries that were not stageable:\n${statusOut.trim().slice(0, 200)}`
              : `git status --porcelain at ${fixTree} was empty`;
          } catch (err) {
            evidence = `git status --porcelain failed at ${fixTree}: ${(err as Error).message?.slice(0, 200)}`;
          }
        }
        next = appendEvent(next, {
          kind: "cap-hit",
          at: Date.now(),
          cap: "lens-fix-not-integrated",
          reviewRound: psFix.reviewRound,
          nextStep: "handoff",
          lensWorktreePath: fixTree,
          evidence,
        });
        trace(`work-driver: lens-fix not integrated — ${cause} (${evidence})`);
        return next;
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
    // N=1 with a pure infra failure: no verdict exists. TWO-STATE design
    // (#486):
    // #486 — N=1 two-state: FIRST pass leaves the dispatch-failed tail for
    // the RETRY_ONCE router; re-entry (priorHadInfraFailure) is permanent —
    // park with the DISTINCT cap `adversarial-infra-failure` (NOT a rejection).
    if (!priorHadInfraFailure) {
      trace(
        "work-driver: adversarial loop infrastructure failure (N=1) — leaving dispatch-failed tail for the RETRY_ONCE router",
      );
    } else {
      const names = failed.map((o) => o.id).join(", ");
      trace(
        `work-driver: adversarial infra failure final for [${names}] — parking with cap 'adversarial-infra-failure' (no verdict exists; NOT a rejection)`,
      );
      // #543 — F4(g): a cap kill (loop / token-budget) parks with its own
      // fixed-literal cap INSTEAD of the generic infra cap.
      const capKill = failed
        .map((o) => capHitForCapKill(o, state.pipelineState.reviewRound))
        .find(Boolean);
      if (capKill) {
        next = appendEvent(next, capKill.event);
        if (capKill.evidence) {
          next = {
            ...next,
            pipelineState: { ...next.pipelineState, capEvidence: capKill.evidence },
          };
        }
        return next;
      }
      // No header to strip on re-entry (the re-entry pass does not
      // re-emit step-started / branches-fanned-out); the cap-hit lands at
      // the tail.
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "adversarial-infra-failure",
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
  } else if (
    failed.every((o) => o.infra || o.threw) &&
    (ids.length === 1
      ? // #298 — N=1 keeps the legacy contract: the driver-level RETRY_ONCE
        // router re-runs the step while the budget holds; only after the
        // router hands it back (retryAttempts exhausted) is the failure
        // final, and it parks with the infra cap instead of the step-failed
        // default — "no verdict exists" is not "the step failed".
        (state.pipelineState.retryAttempts?.adversarial ?? 0) >= 1
      : ids.length > 1
        ? // #486 — re-entry: every failing workstream already has a
          // preserved outcome from a prior run, this pass just re-attempted
          // the infra-failed ones and they still have no verdict. The
          // step-level router cannot retry this (its branches-converged scan
          // declines when ANY workstream succeeded), and re-running inside
          // runAdversarial is bounded by the per-workstream budget — nothing
          // is left to retry. Park with a distinct cap: a permanent infra
          // failure is NOT a rejection.
          priorHadInfraFailure
        : false)
  ) {
    // The N=1 two-state branch above already parked the re-entry pass;
    // reaching here with priorHadInfraFailure means N>1 (or a mixed
    // outcome) — park with the named cap, same shape.

    const names = failed.map((o) => o.id).join(", ");
    trace(
      `work-driver: adversarial infra failure final for [${names}] — parking with cap 'adversarial-infra-failure' (no verdict exists; NOT a rejection)`,
    );
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "adversarial-infra-failure",
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  } else if (
    failed.some(
      (o) => (o.infra || o.threw) && (retries[o.id] ?? 0) >= ADVERSARIAL_PER_WS_MAX_RETRIES,
    )
  ) {
    // #486 — a workstream's per-workstream budget is exhausted and its
    // siblings have real (rejected) verdicts; the rejection path must not
    // swallow the infra shortfall as a fake "rejected". Park the same way.
    const names = failed
      .filter((o) => (o.infra || o.threw) && (retries[o.id] ?? 0) >= ADVERSARIAL_PER_WS_MAX_RETRIES)
      .map((o) => o.id)
      .join(", ");
    trace(
      `work-driver: adversarial per-workstream retry budget exhausted for [${names}] — parking`,
    );
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "adversarial-infra-failure",
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  } else {
    // A genuine verdict (or a first-pass N>1 failure the step-level router
    // will retry wholesale) reached the aggregate. Concatenate rejection text
    // into findings; #486: a workstream with no verdict is named as an
    // explicit shortfall, not folded into the findings.
    const noVerdict = new Set(failed.filter((o) => o.infra || o.threw).map((o) => o.id));
    const findings = failed
      .map((o) => {
        const tag = ids.length > 1 ? `[workstream ${o.id}] ` : "";
        if (noVerdict.has(o.id)) {
          return `${tag}(never produced a verdict — infrastructure failure, NOT a review rejection; see dispatch-failed event)`;
        }
        return `${tag}${o.rejectionText ?? "(dispatch failed — see dispatch-failed event)"}`;
      })
      .join("\n\n---\n\n");
    next = appendEvent(
      next,
      {
        kind: "adversarial-rejected",
        at: Date.now(),
        jobId: aggregateJobId,
        rounds: maxRounds,
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
