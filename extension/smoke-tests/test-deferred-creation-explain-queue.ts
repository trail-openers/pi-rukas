#!/usr/bin/env bun
/**
 * #753 (six-lens FIX 4 + FIX 5) — the deferred-creation park's operator-facing
 * surfaces:
 *
 *  FIX 4: explainCap must return the authored park sentence for
 *  `deferred-creation:develop` (and name the leftover path when the
 *  branch-completed event carries it). The dedicated sentence used to sit
 *  INSIDE the `cap.startsWith("step-failed:")` block — dead code, since the
 *  cap is deliberately named so it does NOT start with that prefix — so the
 *  operator got the generic "step failed: …" fallback.
 *
 *  FIX 5: the queue must attribute the park to `develop` (not
 *  `lastCompletedStep`, which is the last step that SUCCEEDED — typically
 *  `branch`) and give an action that names salvage, not `--restart` (a
 *  re-run before salvage hits the same refusal).
 *
 * `parkReason` is not exported from work-queue.ts (internal to the queue
 * loop); this file therefore drives `humanActionFor` with the reason
 * `parkReason` renders and `renderQueueSummary` with the entry the queue
 * builds — both halves of the rendered output the operator actually sees.
 */

import { explainCap } from "../src/work-driver-explain.ts";
import { type QueueEntry, humanActionFor, renderQueueSummary } from "../src/work-queue.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// A state file at the park: the develop step is in flight, the failed
// workstream's branch-completed event carries the dirty-leftover finding, and
// the cap-hit is the tail.
function parkedState(): WorkState {
  const s = initialState(753, 1) as WorkState;
  s.pipelineState.currentStep = "develop";
  s.pipelineState.lastCompletedStep = "branch";
  s.pipelineState.status = "handoff";
  s.eventLog.push({
    kind: "branch-completed",
    step: "develop",
    workstreamId: "task-b",
    ok: false,
    ms: 0,
    at: 2,
    error:
      "deferred worktree creation refused for task-b — dirty or retained same-issue leftover at /x/.worktrees/issue-753-task-b; parking the cycle",
    deferredCreation: {
      waitedFor: "task-a",
      resolvedBaseRef: "0".repeat(40),
      failure: {
        class: "dirty-leftover",
        leftoverPath: "/x/.worktrees/issue-753-task-b",
        error:
          "refusing to force-remove existing worktree /x/.worktrees/issue-753-task-b — it holds unrecoverable work: 1 uncommitted file(s): leftover.txt",
      },
    },
  });
  s.eventLog.push({
    kind: "cap-hit",
    at: 3,
    cap: "deferred-creation:develop",
    reviewRound: 0,
    nextStep: "handoff",
  });
  return s;
}

// ---------- FIX 4 ----------
{
  const s = parkedState();
  const text = explainCap("deferred-creation:develop", s);
  assert(
    text.includes("deferred worktree creation was refused"),
    "FIX 4: explainCap returns the authored park sentence for deferred-creation:develop",
  );
  assert(
    !text.startsWith("step failed:"),
    "FIX 4: explainCap does NOT fall back to the generic 'step failed: …' sentence",
  );
  assert(
    text.includes("/x/.worktrees/issue-753-task-b"),
    "FIX 4: the park sentence names the leftover path (from the branch-completed event)",
  );
}

// ---------- FIX 5 ----------
// The reason `parkReason` renders for this park (cap + leftover-path suffix),
// and the entry the queue builds (reason + failedStep: "develop" + action).
const REASON = "cap deferred-creation:develop:/x/.worktrees/issue-753-task-b";
{
  const action = humanActionFor(REASON, 753);
  assert(action.includes("salvage"), "FIX 5: the queue action names salvage");
  assert(!action.includes("--restart"), "FIX 5: the queue action does NOT recommend --restart");
  assert(
    action.includes("/x/.worktrees/issue-753-task-b"),
    "FIX 5: the queue action names the leftover path",
  );
  assert(
    action.includes("re-run /work 753") || action.includes("/work 753"),
    "FIX 5: the queue action ends with the re-run instruction",
  );
}
{
  const entry: QueueEntry = {
    groupId: "default",
    issues: [753],
    outcome: "parked",
    reason: REASON,
    failedStep: "develop",
    humanAction: humanActionFor(REASON, 753),
  };
  const summary = renderQueueSummary({
    entries: [entry],
    merged: 0,
    parked: 1,
    refused: 0,
    notStarted: [],
  });
  assert(
    summary.includes("at develop"),
    "FIX 5: the rendered queue summary attributes the park to develop (not branch)",
  );
  assert(summary.includes("salvage"), "FIX 5: the rendered queue summary's action names salvage");
}

process.exit(exit);
