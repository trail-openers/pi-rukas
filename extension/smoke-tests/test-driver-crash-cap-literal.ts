#!/usr/bin/env bun
/**
 * #1263 — the `driver-crash:<step>` cap-hit must pass `validateDiscriminants`
 * when it is the TAIL of a RUNNING state file.
 *
 * Why this test exists on its own: the catch in work-driver.ts (the #1263
 * fix) appends a `driver-crash:<step>` cap and persists the file with
 * `status: "running"`, `currentStep: "handoff"` BEFORE `runHandoff`
 * terminalizes it to `handoff`. If the process dies in that window — the
 * exact mid-flight crash scenario the fix targets — the file stays `running`
 * with the `driver-crash` cap. The cap lives in the `WorkCapLiteral` union
 * as a TEMPLATE (`driver-crash:${WorkStep}`), and work-driver.ts runs the
 * validator on every state read where `status === "running"` — which
 * includes this live crashed-but-unterminalized cycle. Before the prefix was
 * whitelisted as an `isTemplate` value, every re-entry (`/work N`, any
 * resume) halted with "cap has unknown value", telling the operator to
 * delete the exact record this cap exists to create.
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

// A RUNNING state file whose tail is a driver-crash cap validates cleanly
// (the mid-flight crash the #1263 fix targets: status still running, the
// cap already appended, handoff not yet terminalized).
{
  const s = initialState(1263, 1) as WorkState;
  s.pipelineState.currentStep = "handoff";
  s.pipelineState.lastCompletedStep = "plan";
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "driver-crash:plan",
    reviewRound: 0,
    nextStep: "handoff",
  });
  const findings = validateDiscriminants(s);
  assert(
    findings.length === 0,
    `a running state file carrying a driver-crash:plan cap validates cleanly (got: ${JSON.stringify(
      findings,
    )})`,
  );
}

// Every step suffix the union allows validates (the template covers the whole
// WorkStep domain).
{
  const steps = [
    "explore",
    "plan",
    "branch",
    "develop",
    "adversarial",
    "commit-pr",
    "lens-review",
    "lens-fix",
    "ci",
    "merged",
    "step-back",
    "handoff",
  ] as const;
  for (const step of steps) {
    const s = initialState(1263, 1) as WorkState;
    s.pipelineState.currentStep = "handoff";
    s.eventLog.push({
      kind: "cap-hit",
      at: 2,
      cap: `driver-crash:${step}` as never,
      reviewRound: 0,
      nextStep: "handoff",
    });
    const findings = validateDiscriminants(s);
    assert(
      findings.length === 0,
      `driver-crash:${step} validates cleanly (got: ${JSON.stringify(findings)})`,
    );
  }
}

// The canary is not vacuous: a fabricated cap that is NOT one of the known
// templates is still rejected (the #533 "extend the union, don't smuggle a
// field" rule) — and a near-miss of the prefix (`driver-crashed:`) does
// not sneak in via the whitelist either.
{
  const s = initialState(1263, 1) as WorkState;
  s.pipelineState.currentStep = "plan";
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "something-else:plan" as never,
    reviewRound: 0,
    nextStep: "handoff",
  });
  const findings = validateDiscriminants(s);
  assert(
    findings.some((f) => f.includes(".cap has unknown value")),
    `a fabricated something-else:plan is still rejected (got: ${JSON.stringify(
      findings,
    )})`,
  );
}

// A near-miss of the driver-crash prefix is also rejected: the whitelist is
// scoped to the exact prefixes, so a misspelling of `driver-crash:` cannot
// smuggle a fabricated cap past the validator.
{
  const s = initialState(1263, 1) as WorkState;
  s.pipelineState.currentStep = "plan";
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "driver-crashed:plan" as never,
    reviewRound: 0,
    nextStep: "handoff",
  });
  const findings = validateDiscriminants(s);
  assert(
    findings.some((f) => f.includes(".cap has unknown value")),
    `a fabricated driver-crashed:plan near-miss is still rejected (got: ${JSON.stringify(
      findings,
    )})`,
  );
}

process.exit(exit);
