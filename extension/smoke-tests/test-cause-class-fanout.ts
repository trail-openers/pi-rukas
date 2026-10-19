#!/usr/bin/env bun
/**
 * #1675 — a fan-out's empty develop round quotes the reply of the workstream
 * that produced no change, and names the workstream when several are quoted.
 * Split from test-cause-class.ts (the file-size cap).
 */

import { causeForCycle } from "../src/work-driver-cause-for.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A develop fan-out over workstreams a and b; `noChange` are the downgraded (no-change) ones. */
function fanoutNoChange(noChange: string[]): WorkState {
  const workstreams = ["a", "b"];
  const events = [
    { kind: "step-started", at: 1, step: "develop" },
    ...workstreams.map((id) => ({
      kind: "dispatch-completed",
      at: 2,
      step: "develop",
      role: "developer",
      label: `developer[${id}]`,
      jobId: `j-${id}`,
      ok: true,
      ms: 1,
      summary: `I made no change to ${id}; the spec is already met there`,
    })),
    ...workstreams.map((id) => ({
      kind: "branch-completed",
      at: 3,
      step: "develop",
      workstreamId: id,
      ok: !noChange.includes(id),
      ms: 1,
      ...(noChange.includes(id) ? { downgrade: true, error: "no change" } : {}),
    })),
    { kind: "cap-hit", at: 4, cap: "verify-failed:develop", reviewRound: 0, nextStep: "handoff" },
  ];
  return {
    issue: 12,
    schemaVersion: 1,
    resumable: false,
    createdAt: 1,
    updatedAt: 5,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      verifyEvidence: {
        step: "develop",
        failures: ["every assessed worktree has an empty diff"],
        at: 4,
        origin: "outcome-gate",
      },
    },
    eventLog: events,
  } as unknown as WorkState;
}

const one = causeForCycle(fanoutNoChange(["a"]));
assert(one?.causeClass === "change", "a fan-out with one no-change workstream is change");
assert(
  one?.causeEvidence.join("\n").includes("I made no change to a") === true &&
    !(one?.causeEvidence ?? []).join("\n").includes("I made no change to b"),
  "the quoted reply is the no-change workstream's, not the other's",
);
assert(
  !(one?.causeEvidence ?? []).some((l) => l.startsWith("workstream ")),
  "one quoted reply is not prefixed with a workstream name",
);
const two = causeForCycle(fanoutNoChange(["a", "b"]));
assert(
  (two?.causeEvidence ?? []).some((l) => l.startsWith("workstream a: ")) &&
    (two?.causeEvidence ?? []).some((l) => l.startsWith("workstream b: ")),
  "several quoted replies each name their workstream",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
