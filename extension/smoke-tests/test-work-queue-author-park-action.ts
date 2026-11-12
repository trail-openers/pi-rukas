#!/usr/bin/env bun
/**
 * #2181 — the queue's action for an AUTHOR park names the author rule, not `--merge`.
 *
 * `parkReason` tags an author park `awaiting-human-merge:granted:prN:author`; the
 * router in `work-queue-cap.ts` matched `(…)(?::head)?` only, so the suffix fell
 * through to the CI-flavoured action: "check the failing/incomplete required
 * checks … then re-run with --merge". Both halves of that advice are wrong for this
 * park — the CI is green, and no flag reaches the author gate — so the operator
 * would re-run an unchanged cycle into the same park.
 *
 * Pinned end to end: the reason the state file earns, and the action the operator
 * reads for that reason.
 */

import { parkReason } from "../src/work-queue-park-reason.ts";
import { humanActionFor } from "../src/work-queue.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

/** A cycle the author gate held: green everything, one hold field set. */
function authorPark(reason: string): WorkState {
  const s = initialState(2181, 1) as WorkState;
  s.pipelineState.currentStep = "merged";
  s.pipelineState.lastCompletedStep = "ci";
  s.pipelineState.status = "handoff";
  s.pipelineState.prNumber = 99;
  s.pipelineState.mergeHold = {
    authorityGranted: true,
    authoritySource: "doctrine",
    authorGateReason: reason,
  };
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "awaiting-human-merge",
    reviewRound: 0,
    nextStep: "handoff",
  } as WorkState["eventLog"][number]);
  return s;
}

const REASON = "the PR author `mallory` is not listed in .pi/merge-authors";

{
  const state = authorPark(REASON);
  const { reason } = parkReason(state);
  assert(
    reason.includes(":author"),
    `the park reason carries the :author tag (${reason})`,
  );

  const action = humanActionFor(reason, 2181, [2181], state.pipelineState.mergeHold);
  assert(
    /author/i.test(action),
    `the queue's action names the author rule (${action.slice(0, 200)})`,
  );
  assert(
    !/re-run with --merge/.test(action),
    `…and does not tell the operator to re-run with --merge, which cannot reach this gate (${action.slice(0, 200)})`,
  );
  assert(
    !/required checks/.test(action),
    `…and does not send them to the required checks on a PR whose CI is green (${action.slice(0, 200)})`,
  );
  assert(
    action.includes(REASON),
    "…and quotes the gate's own refusal, so the operator sees WHICH author and file",
  );
}
{
  // The control: the same shape with no author reason keeps the CI action, so the
  // new branch cannot be a blanket override of every merge park.
  const state = authorPark(REASON);
  state.pipelineState.mergeHold = {
    authorityGranted: true,
    authoritySource: "doctrine",
  };
  const { reason } = parkReason(state);
  const action = humanActionFor(reason, 2181, [2181], state.pipelineState.mergeHold);
  assert(
    /--merge/.test(action),
    `a merge park with no author reason still gets the CI-flavoured action (${action.slice(0, 160)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
