/**
 * work-driver-run-step — the step dispatch table: one step's handler, chosen
 * by `currentStep`. Split out of work-driver.ts (500-line cap); the
 * PR-gone check (work-driver-pr-gone.ts) guards the steps that touch the PR.
 */
import { trace } from "./trace.ts";
import { runAdversarial } from "./work-driver-adversarial.ts";
import { runBranch, runDevelop, stampCycleStartRef } from "./work-driver-branch-develop.ts";
import { runCommitPr } from "./work-driver-commit.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { markDraftPrReady } from "./work-driver-draft-pr.ts";
import { runExplore } from "./work-driver-explore.ts";
import { runHandoff } from "./work-driver-handoff.ts";
import { runLensFix } from "./work-driver-lens-fix.ts";
import { runLens } from "./work-driver-lens.ts";
import { runMerged } from "./work-driver-merged.ts";
import { runPlan } from "./work-driver-plan.ts";
import { endIfPrGone } from "./work-driver-pr-gone.ts";
import { runCi, runStepBack } from "./work-driver-stepback-ci.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";

/**
 * Run a single step end-to-end: load template (or judge inline for PM-
 * judgment-shaped steps), dispatch via `dispatchCore`, await, append
 * event(s), update pipelineState. Returns the new state. Persistence is
 * the caller's responsibility (so multi-step transitions don't double-write).
 *
 * Per-step implementations are intentionally separated rather than
 * collapsed into one big switch — each step's prompt template, role
 * selection, and event-emission logic is distinct enough that a giant
 * switch becomes harder to read than a dispatch table.
 */
export async function runStep(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
): Promise<WorkState> {
  const now = Date.now();
  trace(`work-driver: running step "${step}" for issue ${ctx.issue}`);

  switch (step) {
    case "explore":
      return runExplore(ctx, state, now);
    case "plan":
      return runPlan(ctx, state, now);
    case "branch":
      return runBranch(ctx, await stampCycleStartRef(ctx, state), now);
    case "develop":
      return runDevelop(ctx, state, now);
    case "adversarial":
      return runAdversarial(ctx, state, now);
    case "commit-pr":
      return runCommitPr(ctx, state, now);
    // A PR merged or closed under the review ends the cycle before the step.
    case "lens-review": {
      const gate = await endIfPrGone(ctx, state, step);
      return gate.ended ?? runLens(ctx, gate.state, now);
    }
    case "lens-fix": {
      const gate = await endIfPrGone(ctx, state, step);
      return gate.ended ?? runLensFix(ctx, gate.state, now);
    }
    case "step-back":
      return runStepBack(ctx, state, now);
    // #1292 — the review is done: a draft PR is marked ready before CI.
    case "ci": {
      const gate = await endIfPrGone(ctx, state, step);
      return gate.ended ?? runCi(ctx, await markDraftPrReady(ctx, gate.state), now);
    }
    case "handoff":
      return runHandoff(ctx, state, now);
    case "merged":
      return runMerged(ctx, state, now);
  }
}
