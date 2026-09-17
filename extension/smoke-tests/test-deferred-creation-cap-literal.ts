#!/usr/bin/env bun
/**
 * #753 (six-lens FIX 1) — the `deferred-creation:develop` cap-hit must pass
 * `validateDiscriminants` when it is the TAIL of a RUNNING state file.
 *
 * Why this test exists on its own: work-driver.ts runs the validator on every
 * state read where `status === "running"` — which includes a live parked
 * cycle whose tail IS this cap (the handoff step that flips the status to
 * "handoff" runs after the read, and a cycle killed mid-step leaves the file
 * running). Before the literal was whitelisted, every re-entry (`/work 753
 * --restart`, any resume) halted with "state file carries an unrecognised
 * value — rm to start fresh", telling the operator to delete the exact
 * record this issue exists to create.
 *
 * The 32-assertion suite in test-work-driver-dep-deferred-creation.ts cannot
 * catch this class: it drives runDependentWorkstreams in-process and never
 * round-trips the state through the validator. This file does.
 */

import { validateDiscriminants } from "../src/workflow-state-validate.ts";
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

// A RUNNING state file whose tail is the deferred-creation cap (the shape of
// a parked cycle whose status has not yet flipped to handoff) validates
// cleanly.
{
  const s = initialState(753, 1) as WorkState;
  s.pipelineState.currentStep = "develop";
  s.pipelineState.lastCompletedStep = "branch";
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "deferred-creation:develop",
    reviewRound: 0,
    nextStep: "handoff",
  });
  const findings = validateDiscriminants(s);
  assert(
    findings.length === 0,
    `a running state file carrying the deferred-creation:develop cap validates cleanly (got: ${JSON.stringify(findings)})`,
  );
}

// The canary is not vacuous: a fabricated near-miss on the new literal is
// still rejected (the #533 "extend the union, don't smuggle a field" rule).
{
  const s = initialState(754, 1) as WorkState;
  s.pipelineState.currentStep = "develop";
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "deferred-creation:develop:task-b" as "deferred-creation:develop",
    reviewRound: 0,
    nextStep: "handoff",
  });
  const findings = validateDiscriminants(s);
  assert(
    findings.some((f) => f.includes(".cap has unknown value")),
    `a fabricated deferred-creation:develop:<suffix> is still rejected (got: ${JSON.stringify(findings)})`,
  );
}

process.exit(exit);
