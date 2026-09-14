/**
 * #533/#728 — the new `consolidation-incomplete` cap discriminator must be a
 * KNOWN fixed literal for the state-file validator: the #533 canary refuses
 * fabricated cap strings ("extend the union, don't smuggle a field"), so the
 * cap the cherry-pick seam's droppedPaths diagnostic is routed to must be in
 * the whitelist or a valid state file would be rejected on resume.
 *
 * Also canaries the #533-style validation of the new
 * `pipelineState.consolidationCompleteness` record (a partial object must be
 * refused, not rendered as a confident wrong dropped-path list).
 *
 * Not a regression test of the #723 strict-subset drop itself (that is
 * task-d's test-work-driver-consolidation-drop.ts) — this file proves the
 * state-file vocabulary the detection is routed through.
 */

import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { initialState, appendEvent } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// A valid cap-hit with the new discriminator passes the validator.
{
  const s = initialState(1, 728);
  appendEvent(s, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "consolidation-incomplete",
    reviewRound: 1,
    nextStep: "handoff",
    evidence: "dropped: extension/src/work-driver-cherry-pick.ts, extension/smoke-tests/test-a.ts",
  });
  const findings = validateDiscriminants(s as unknown);
  assert(
    findings.length === 0,
    `consolidation-incomplete cap is a known fixed literal (validator: ${JSON.stringify(findings)})`,
  );
}

// A fabricated near-miss is still rejected — the canary is not vacuous.
// (Direct state object: appendEvent returns a NEW state, so the validator
// must run on the returned value to see the event it just appended.)
{
  const s = initialState(1, 729);
  const out = appendEvent(s, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "consolidation-incomplete:task-a" as "consolidation-incomplete",
    reviewRound: 1,
    nextStep: "handoff",
  });
  const findings = validateDiscriminants(out as unknown);
  assert(
    findings.some((f) => f.includes("cap has unknown value")),
    `a fabricated consolidation-incomplete:<suffix> cap is still rejected (${JSON.stringify(findings)})`,
  );
}

// The consolidationCompleteness record: a complete one validates; a partial
// one is refused (the #533 "type-check the untyped cast" rule).
{
  const s = initialState(1, 730);
  s.pipelineState.consolidationCompleteness = {
    intended: ["a.ts", "b.ts"],
    landed: ["a.ts", "b.ts"],
    droppedPaths: [],
  };
  const findings = validateDiscriminants(s as unknown);
  assert(findings.length === 0, "a complete consolidationCompleteness record validates");

  s.pipelineState.consolidationCompleteness = {
    intended: ["a.ts"],
    landed: [],
    droppedPaths: ["a.ts"],
    checkError: "boom",
  };
  const findings2 = validateDiscriminants(s as unknown);
  assert(findings2.length === 0, "a consolidationCompleteness record with checkError validates");

  (s.pipelineState as Record<string, unknown>).consolidationCompleteness = {
    intended: ["a.ts"],
    landed: [],
    droppedPaths: "a.ts",
  };
  const findings3 = validateDiscriminants(s as unknown);
  assert(
    findings3.some((f) => f.includes("droppedPaths is missing or not an array")),
    "a partial consolidationCompleteness record is refused",
  );
}

process.exit(exit);
