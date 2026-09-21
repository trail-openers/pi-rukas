/**
 * work-driver-adversarial — Step 5 (adversarial gate) handler.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Fans out
 * one `runAdversarialLoop` call per workstream, aggregates the verdict,
 * and — on approval following a lens-fix round — commits the fix via
 * work-driver-lens.ts's `commitLensFixChanges`.
 *
 * #492/#749 — when a lens-fix never reaches the branch, the cap-hit carries
 * the CAUSE (committed-work detection via rev-list, not porcelain) and the
 * git evidence that establishes it, plus the worktree inspected.
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
import { integrate, restoreRepoRoot, withIntegrationLock } from "./work-driver-integrate.ts";
import {
  detectCommittedFix,
  landCommittedFix,
  noDiffEvidence,
} from "./work-driver-lens-fix-commit.ts";
import { commitLensFixChanges, lensWorktree } from "./work-driver-lens.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

const execp = promisify(exec);

/** #287 Part C — re-integrate a lens-fix made in a worktree. See #654 task-c. */
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
  if (!res.ok) {
    if (res.failure === "dirty-repoRoot" && res.porcelain) {
      const outcome = await restoreRepoRoot(execFn, ctx.repoRoot, res.porcelain);
      if (outcome.restored) {
        const retry = await integrate(execFn, {
          repoRoot: ctx.repoRoot,
          branchName,
          worktrees,
          scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
          commitTitle: `fix(lens): round ${round} review findings`,
          commitBody: `Addresses six-pass review findings from round ${round}.`,
          mode: "followup",
        });
        if (!retry.ok) {
          return {
            committed: false,
            error: `restored repoRoot (stash+pop) but the retry still failed: ${retry.reason}`,
          };
        }
        if (retry.empty) return { committed: false };
        return { committed: true, pushed: true };
      }
      return {
        committed: false,
        error: `dirty repoRoot at lens-fix time, not safely restorable — ${outcome.reason}. Porcelain: ${res.porcelain
          .slice(0, 5)
          .join("; ")}`,
      };
    }
    return { committed: false, error: res.reason };
  }
  if (res.empty) return { committed: false };
  return { committed: true, pushed: true };
}

/**
 * #749 — committed-work-aware classification for the `!result.committed`
 * branch. Returns the post-handling state, or null to proceed.
 */
async function handleNoCommittedFix(
  execFn: ExecFn,
  ctx: DriverContext,
  ps: PipelineState,
  fixTree: string,
  result: { committed: boolean; error?: string; pushed?: boolean },
  stateIn: WorkState,
): Promise<WorkState | null> {
  let state = stateIn;
  if (result.error) return null;
  if (!ps.branchName) {
    return appendEvent(state, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "lens-fix-not-integrated",
      reviewRound: ps.reviewRound,
      nextStep: "handoff",
      lensWorktreePath: fixTree,
      evidence: `no committed fix and no branch name recorded — cannot measure committed work in ${fixTree}`,
    });
  }
  const branchName = ps.branchName;
  const fix = await detectCommittedFix(execFn, fixTree, branchName);
  if (fix.status === "committed") {
    if (fix.diffEmpty) {
      trace(
        "work-driver: lens-fix committed and already on the branch — proceeding to re-review (no cap)",
      );
      return null;
    }
    const landed = await landCommittedFix(execFn, ctx, ps, fixTree);
    if (landed.ok) {
      // #776 — ok covers both "landed" and "tree-hash-dedup skip" (#749).
      // The work is on the branch; no cap.
      const sha = landed.sha;
      let pushOk = true;
      try {
        await execFn(`git push origin ${JSON.stringify(branchName)}`, {
          cwd: ctx.repoRoot,
          maxBuffer: 1024 * 1024,
        });
      } catch {
        pushOk = false;
      }
      if (!pushOk) {
        state = {
          ...state,
          pipelineState: {
            ...state.pipelineState,
            plumbReports: [
              ...state.pipelineState.plumbReports,
              {
                step: "adversarial",
                role: "driver",
                body: `lens-fix landed locally but the push failed — check the remote for ${branchName}`,
                at: Date.now(),
              },
            ],
          },
        };
      }
      trace(
        `work-driver: lens-fix committed fix ${sha.slice(0, 8)} landed on ${branchName} — proceeding to re-review`,
      );
      return null;
    }
    // #776 — integration genuinely failed (e.g. cherry-pick conflict). The
    // work stays in the worktree ahead of base; captureCommittedWork (handoff)
    // records the HEAD SHA in committedWork so the operator can recover it.
    return appendEvent(state, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "lens-fix-not-integrated",
      reviewRound: ps.reviewRound,
      nextStep: "handoff",
      lensWorktreePath: fixTree,
      evidence: `committed fix in ${fixTree} (${fix.count} commit(s) ahead of ${branchName}) — integration genuinely failed: ${landed.error}. The fix's worktree HEAD SHA is recorded in the handoff snapshot's committedWork so it can be recovered (git cherry-pick from ${fixTree}).`,
    });
  }
  const evidence =
    fix.status === "no-commits"
      ? noDiffEvidence(fixTree, branchName, fix.count)
      : `no committed fix and the count of commits ahead of ${branchName} in ${fixTree} could not be read (git error)`;
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "lens-fix-not-integrated",
    reviewRound: ps.reviewRound,
    nextStep: "handoff",
    lensWorktreePath: fixTree,
    evidence,
  });
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
  const ids =
    Object.keys(state.pipelineState.workstreams ?? {}).length > 0
      ? Object.keys(state.pipelineState.workstreams ?? {})
      : ["default"];

  const priorOutcomes = new Map<string, string>();
  for (const e of state.eventLog) {
    if (e.kind === "adversarial-workstream-outcome") {
      priorOutcomes.set(e.workstreamId, e.outcome);
    }
  }
  const priorHadInfraFailure = [...priorOutcomes.values()].some((o) =>
    ["infra-failure", "dispatch-failed"].includes(o),
  );
  const priorBatchSpan = priorHadInfraFailure ? reentryPassBatchSpan(state.eventLog) : null;
  const retries = state.pipelineState.adversarialTransientRetries ?? {};
  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "adversarial" },
  };
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
    const infraShortfall = outcomes.filter((o) => o.infra || o.threw);
    const names = infraShortfall.map((o) => o.id).join(", ");
    trace(
      `work-driver: adversarial per-workstream retry budget exhausted on first pass for [${names}] — parking`,
    );
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

    if (state.pipelineState.lastCompletedStep === "lens-fix") {
      const execFn = ctx.verifyExecFn ?? execp;
      const psFix = state.pipelineState;
      const fixWorktrees = psFix.worktrees ?? {};
      const inWorktree = Object.values(fixWorktrees).some(
        (p) => path.resolve(p) !== path.resolve(ctx.repoRoot),
      );
      const result = inWorktree
        ? await integrateLensFix(execFn, ctx, psFix, fixWorktrees)
        : await commitLensFixChanges(ctx.repoRoot, psFix.reviewRound, execFn);
      if (!result.committed) {
        const fixTree = inWorktree ? lensWorktree(ctx, state) : ctx.repoRoot;
        if (result.error) {
          next.pipelineState.plumbReports.push({
            step: "adversarial",
            role: "driver",
            body: `lens-fix: a diff existed but staging or integration failed (${result.error}) — worktree inspected: ${fixTree}`,
            at: Date.now(),
          });
          next = appendEvent(next, {
            kind: "cap-hit",
            at: Date.now(),
            cap: "lens-fix-not-integrated",
            reviewRound: psFix.reviewRound,
            nextStep: "handoff",
            lensWorktreePath: fixTree,
            evidence: result.error,
          });
          trace(`work-driver: lens-fix integration failed — ${result.error}`);
          return next;
        }
        const handled = await handleNoCommittedFix(execFn, ctx, psFix, fixTree, result, next);
        if (handled !== null) return handled;
      }
      if (result.committed && !result.pushed) {
        try {
          await execFn("git push origin HEAD -q", { cwd: ctx.repoRoot, maxBuffer: 64 * 1024 });
        } catch (err) {
          const errMsg = `lens-fix push failed (non-blocking): ${(err as Error).message?.slice(0, 200)}`;
          trace(`work-driver: ${errMsg}`);
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
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "adversarial-infra-failure",
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
  } else if (
    failed.every(
      (o) => o.infra || o.threw || (retries[o.id] ?? 0) >= ADVERSARIAL_PER_WS_MAX_RETRIES,
    ) &&
    (ids.length === 1
      ? // #298 — N=1 keeps the legacy contract: the driver-level RETRY_ONCE
        // router re-runs the step while the budget holds; only after the
        // router hands it back (retryAttempts exhausted) is the failure
        // final, and it parks with the infra cap instead of the step-failed
        // default — "no verdict exists" is not "the step failed".
        // A workstream whose per-workstream retry budget is exhausted is
        // likewise final — the rejection path must not swallow the infra
        // shortfall as a fake "rejected" (#486). Parks the same way.
        (state.pipelineState.retryAttempts?.adversarial ?? 0) >= 1 ||
        failed.some((o) => (retries[o.id] ?? 0) >= ADVERSARIAL_PER_WS_MAX_RETRIES)
      : // #486 — re-entry: every failing workstream already has a preserved
        // outcome from a prior run, this pass just re-attempted the infra-failed
        // ones and they still have no verdict. The step-level router cannot
        // retry this (its branches-converged scan declines when ANY workstream
        // succeeded), and re-running inside runAdversarial is bounded by the
        // per-workstream budget — nothing is left to retry. A permanent infra
        // failure is NOT a rejection, so it parks with the distinct cap.
        priorHadInfraFailure ||
        failed.some((o) => (retries[o.id] ?? 0) >= ADVERSARIAL_PER_WS_MAX_RETRIES))
  ) {
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
