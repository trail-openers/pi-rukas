#!/usr/bin/env bun
/**
 * #973 — the `no-review-outcome` cap-hit must pass `validateDiscriminants`
 * when it is the TAIL of a RUNNING state file.
 *
 * Why this test exists on its own: work-driver.ts runs the validator on every
 * state read where `status === "running"` — which includes a live parked
 * cycle whose tail IS this cap (work-driver-lens.ts emits the cap when a
 * lens review produced no review outcome; a cycle killed mid-step leaves the
 * file running). Before the literal was whitelisted, every re-entry
 * (`/work N --restart`, any resume) halted with "state file carries an
 * unrecognised value — rm to start fresh", telling the operator to delete
 * the exact record this cap exists to create.
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

// A RUNNING state file whose tail is the no-review-outcome cap validates
// cleanly.
{
  const s = initialState(973, 1) as WorkState;
  s.pipelineState.currentStep = "lens-review";
  s.pipelineState.lastCompletedStep = "commit-pr";
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "no-review-outcome",
    reviewRound: 0,
    nextStep: "handoff",
  });
  const findings = validateDiscriminants(s);
  assert(
    findings.length === 0,
    `a running state file carrying the no-review-outcome cap validates cleanly (got: ${JSON.stringify(findings)})`,
  );
}

// The canary is not vacuous: a fabricated near-miss on the new literal is
// still rejected (the #533 "extend the union, don't smuggle a field" rule).
{
  const s = initialState(974, 1) as WorkState;
  s.pipelineState.currentStep = "lens-review";
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "no-review-outcome:delta" as "no-review-outcome",
    reviewRound: 0,
    nextStep: "handoff",
  });
  const findings = validateDiscriminants(s);
  assert(
    findings.some((f) => f.includes(".cap has unknown value")),
    `a fabricated no-review-outcome:<suffix> is still rejected (got: ${JSON.stringify(findings)})`,
  );
}

process.exit(exit);
