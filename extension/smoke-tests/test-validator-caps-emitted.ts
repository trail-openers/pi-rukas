#!/usr/bin/env bun
/**
 * #1338 — the state validator accepts every cap the driver can emit.
 *
 *   - every published fixed cap validates as the tail of a running state file
 *     (cross-group-conflict, plan-timeout and repeat-finding-seam were missing)
 *   - every template family validates over every step
 *   - the validator's list and the published list are the same set
 *   - a fabricated suffix on a fixed literal is still rejected
 *
 * The compile-time half (the list against WorkCapLiteral) lives in
 * workflow-state-validate-caps.ts and fails `tsc`. Offline: in-memory only.
 */
import { CAP_TEMPLATES, FIXED_CAPS } from "../src/headless/caps.ts";
import type { WorkCapLiteral } from "../src/workflow-state-events-caps.ts";
import { WORK_STEPS } from "../src/workflow-state-schema.ts";
import { CAP_HIT_FIXED_LITERALS } from "../src/workflow-state-validate-caps.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function findingsFor(cap: string): string[] {
  const s = initialState(1338, 1) as WorkState;
  s.pipelineState.currentStep = "develop";
  s.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: cap as WorkCapLiteral,
    reviewRound: 0,
    nextStep: "handoff",
  });
  return validateDiscriminants(s);
}

const rejected = FIXED_CAPS.filter((c) => findingsFor(c).length > 0);
assert(
  rejected.length === 0,
  `every published fixed cap validates (rejected: ${rejected.join(", ")})`,
);
for (const cap of ["cross-group-conflict", "plan-timeout", "repeat-finding-seam"]) {
  assert(findingsFor(cap).length === 0, `${cap} validates`);
}

const badTemplates: string[] = [];
for (const [family, parameter] of Object.entries(CAP_TEMPLATES)) {
  const values = parameter === "step" ? WORK_STEPS : ["3"];
  for (const v of values) {
    if (findingsFor(`${family}:${v}`).length > 0) badTemplates.push(`${family}:${v}`);
  }
}
assert(
  badTemplates.length === 0,
  `every template cap validates (rejected: ${badTemplates.join(", ")})`,
);

const validator = [...(CAP_HIT_FIXED_LITERALS as readonly string[])].sort();
assert(
  JSON.stringify(validator) === JSON.stringify([...FIXED_CAPS]),
  "the validator's fixed caps are exactly the published fixed caps",
);

assert(
  findingsFor("plan-timeout:develop").some((f) => f.includes(".cap has unknown value")),
  "a fabricated suffix on a fixed literal is still rejected",
);
assert(
  findingsFor("made-up-cap").some((f) => f.includes(".cap has unknown value")),
  "an unknown cap is still rejected",
);

process.exit(exit);
