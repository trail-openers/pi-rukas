#!/usr/bin/env bun
/**
 * #1463 — a cap-hit handoff must not announce itself as "aborted (mid-flight
 * failure, not a cap-hit)", and `Last step:` names the step that stopped, not
 * the last one that completed.
 *
 * Two measured cycles: the developer was killed at the backstop,
 * the driver recorded `cap developer-timeout` and ran the handoff, and the
 * rendered message then read `Last step: branch` / `Cycle: aborted (mid-flight
 * failure, not a cap-hit)`. `runHandoff` stores `aborted` for the bound/kill
 * caps on purpose, so the status word cannot be the source of that line.
 */

import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { renderCycleIndex } from "../src/work-status-index.ts";
import { renderTerminalStatus } from "../src/work-status.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string, detail?: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}${detail ? `\n${detail}` : ""}`);
    exit = 1;
  }
}

const REPO = "/tmp/repo";

function developKilled(): WorkState {
  let s = initialState(285, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "aborted" as const,
      currentStep: "handoff" as const,
      lastCompletedStep: "branch" as const,
      branchName: "feature/issue-285-x",
    },
  };
  s = appendEvent(s, { kind: "step-started", at: 1_000_100, step: "develop" });
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_200,
    cap: "developer-timeout",
    reviewRound: 0,
    nextStep: "handoff",
  });
  s = appendEvent(s, { kind: "step-started", at: 1_000_300, step: "handoff" });
  return s;
}

function crashed(): WorkState {
  let s = initialState(286, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      status: "aborted" as const,
      currentStep: "develop" as const,
      lastCompletedStep: "branch" as const,
    },
  };
  return appendEvent(s, { kind: "step-started", at: 1_000_100, step: "develop" });
}

const capped = renderHandoffUserMessage(developKilled(), REPO, `${REPO}/tmp/issue-285`);
assert(!capped.includes("not a cap-hit"), "a recorded cap is never called 'not a cap-hit'", capped);
assert(
  capped.includes("Cycle: aborted — handoff (cap developer-timeout, step develop)"),
  "the Cycle line names the cap and the step that stopped",
  capped,
);
assert(capped.includes("Last step: develop"), "Last step is the step in flight, not `branch`");
assert(!capped.includes("Last step: branch"), "the last COMPLETED step is not offered as the stop");

const crash = renderHandoffUserMessage(crashed(), REPO, `${REPO}/tmp/issue-286`);
assert(
  crash.includes("Cycle: aborted (mid-flight failure, not a cap-hit)"),
  "an aborted cycle with no cap is still a mid-flight failure",
  crash,
);

const status = renderTerminalStatus(developKilled(), REPO);
assert(
  status.includes("ABORTED — handoff (cap developer-timeout, step develop"),
  "/work-status badge agrees with the handoff",
  status,
);
assert(!status.includes("mid-flight failure"), "/work-status does not call a cap a crash");
assert(
  renderTerminalStatus(crashed(), REPO).includes("ABORTED (mid-flight failure"),
  "/work-status keeps the crash badge for a cap-less abort",
);

const index = renderCycleIndex([{ issue: 285, state: developKilled() }]);
assert(
  index.includes("cap developer-timeout at develop"),
  "the cycle index names the stop step",
  index,
);

process.exit(exit);
