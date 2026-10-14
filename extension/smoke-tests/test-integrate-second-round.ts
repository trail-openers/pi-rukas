#!/usr/bin/env bun
/**
 * The second integration round — two defects (#1235) from two parked cycles
 * that each ran ~4.5 h and ended with the work stranded on a detached
 * worktree. (A third, the integrate worktree refusing the cycle's own
 * workstream tree, is #1185's and is tested there.)
 *
 *  1. ROUTING. `routeStepOutcome` drained the cycle's `dispatch-slow` events
 *     onto the TAIL of the event log, and `nextStep()` routes on the tail. A
 *     post-lens-fix adversarial review that crossed the slow threshold had
 *     its `adversarial-approved` shadowed, fell through to the linear table
 *     (`adversarial → commit-pr`) and re-ran commit-pr instead of going to
 *     lens-review — which rebuilt the branch from base and pushed
 *     non-fast-forward. The same shadowing skipped a fix request and a cap.
 *  2. HANDOFF TEXT. "branch pushed to origin: yes" beside "it is not yet
 *     pushed" — the snapshot bit means "origin has the branch".
 *
 * Offline: temp dirs, no network, no model.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearSlowEventsForTesting, foldSlowEvents, slowRecorder } from "../src/slow-events.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { nextStep } from "../src/work-driver-context.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery-caps.ts";
import { routeStepOutcome } from "../src/work-driver-step-router.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import type { WorkEvent, WorkState, WorkStep } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "pi-ens-second-round-"));
const ISSUE = 46;

/** One crossing recorded during `step`, as the slow watch would push it. */
function crossSlow(step: WorkStep) {
  slowRecorder(ISSUE, step)({
    step,
    role: "adversarial-developer",
    jobId: "slow-job",
    label: "adversarial-developer[round1-review]",
    elapsedMs: 1_200_000,
    turns: 16,
    tokens: 986_000,
    at: Date.now(),
  });
}

/** A cycle sitting at the end of `step`, having arrived from `from`, with `tail` appended. */
function stateAfter(step: WorkStep, from: WorkStep, ...tail: WorkEvent[]): WorkState {
  let st = initialState(ISSUE, 1000);
  st = {
    ...st,
    pipelineState: { ...st.pipelineState, currentStep: step, lastCompletedStep: from },
  };
  return appendEvent(st, { kind: "step-started", step, at: 2000 }, ...tail);
}

async function routed(step: WorkStep, state: WorkState): Promise<WorkState> {
  const repoRoot = path.join(root, `route-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repoRoot, { recursive: true });
  const ctx = { host: {}, repoRoot, issue: ISSUE } as unknown as DriverContext;
  const out = await routeStepOutcome(ctx, state, step, { num: 5, total: 9 }, 1, Date.now());
  return out.state;
}

const stepOf = (s: WorkState) => {
  const d = nextStep(s);
  return d.kind === "step" ? d.step : d.kind;
};

// ---------------------------------------------------------------- 1. routing
{
  clearSlowEventsForTesting();
  const approved: WorkEvent = { kind: "adversarial-approved", at: 3000, jobId: "j", rounds: 1 };

  // The control: no crossing → the post-lens-fix approval goes to re-review.
  const quiet = await routed("adversarial", stateAfter("adversarial", "lens-fix", approved));
  assert(stepOf(quiet) === "lens-review", "control: approval after lens-fix → lens-review");

  // The incident: the review crossed the slow threshold during the step.
  crossSlow("adversarial");
  const slow = await routed("adversarial", stateAfter("adversarial", "lens-fix", approved));
  assert(
    slow.eventLog.filter((e) => e.kind === "dispatch-slow").length === 1,
    "the crossing still lands in the log exactly once",
  );
  assert(
    slow.eventLog[slow.eventLog.length - 1]?.kind === "adversarial-approved",
    "the step's verdict is still the TAIL after the slow drain",
  );
  assert(
    stepOf(slow) === "lens-review",
    `a slow review after lens-fix → lens-review, NOT a second commit-pr (got ${stepOf(slow)})`,
  );

  // The same shadowing skipped a fix request...
  crossSlow("adversarial");
  const fix = await routed(
    "adversarial",
    stateAfter("adversarial", "develop", {
      kind: "adversarial-fix-requested",
      at: 3000,
      workstreamId: "default",
      round: 1,
      findings: "f",
    } as WorkEvent),
  );
  assert(stepOf(fix) === "develop", `a slow review's fix request → develop (got ${stepOf(fix)})`);

  // ...and a cap: a rejection must reach handoff, not commit-pr.
  crossSlow("adversarial");
  const capped = await routed(
    "adversarial",
    stateAfter("adversarial", "develop", {
      kind: "cap-hit",
      at: 3000,
      cap: "adversarial-loop",
      reviewRound: 0,
      nextStep: "handoff",
    }),
  );
  assert(stepOf(capped) === "handoff", `a slow review's cap-hit → handoff (got ${stepOf(capped)})`);

  // No step-started to anchor on: the slow events still never become the tail.
  const slowEv = slow.eventLog.find((e) => e.kind === "dispatch-slow") as WorkEvent;
  const folded = foldSlowEvents([approved], [slowEv], "adversarial");
  assert(
    folded.length === 2 && folded[1]?.kind === "adversarial-approved",
    "foldSlowEvents without a step-started keeps the verdict last",
  );
  assert(foldSlowEvents([], [slowEv], "adversarial").length === 1, "…and an empty log just holds it");
}

// ----------------------------------------------------------- 2. handoff text
{
  const branch = "feature/issue-46-x";
  const parked = (branchPushed: boolean): WorkState => {
    let st = initialState(ISSUE, 1000);
    st = appendEvent(
      st,
      { kind: "handoff-consolidated", at: 2000, branchName: branch, workstreams: ["default"] },
      {
        kind: "cap-hit",
        at: 3000,
        cap: "integration-worktree-violation",
        reviewRound: 1,
        nextStep: "handoff",
      },
    );
    return {
      ...st,
      pipelineState: {
        ...st.pipelineState,
        branchName: branch,
        handoffSnapshot: {
          modifiedFiles: [],
          unstagedCount: 0,
          stagedCount: 0,
          branchExists: true,
          branchPushed,
          headSha: "5c1c543",
          capturedAt: 3000,
          committedWork: [{ worktreeId: "default", path: "/w", headSha: "17b7f3ab", ahead: 3 }],
        },
      },
    };
  };
  const text = (s: WorkState) =>
    recoveryStepsForCap(s)
      .steps.flatMap((x) => [...(x.comment ?? []), ...x.lines])
      .join("\n");
  const onOrigin = text(parked(true));
  assert(
    !/not yet pushed/.test(onOrigin) && /EARLIER push/.test(onOrigin),
    "branch already on origin: the push step no longer says 'not yet pushed'",
  );
  assert(onOrigin.includes(`git push -u origin ${branch}`), "…and still gives the push command");
  assert(
    /not yet pushed/.test(text(parked(false))),
    "branch not on origin: the original 'not yet pushed' wording is kept",
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
