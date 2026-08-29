#!/usr/bin/env bun
/**
 * #543 F4(h) — nextStep routes BOTH dispatch-cap cap strings
 * (`loop-detected` / `token-budget`) to handoff from every cap-emitting
 * step. The cap-hit event is the routing input — nextStep reads
 * `lastEvent.nextStep`. Split from test-work-driver-pr4.ts (AGENTS.md
 * §12 file-size limit).
 */

import { nextStep } from "../src/work-driver-context.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
{
  // (h) nextStep routes BOTH cap strings to handoff. The cap-hit event is the
  // routing input — nextStep reads `lastEvent.nextStep`, so a cap-hit with
  // nextStep:"handoff" reaches handoff for every step that emits it.
  for (const cap of ["loop-detected", "token-budget"] as const) {
    let s = initialState(543, 1_000_000);
    s = { ...s, pipelineState: { ...s.pipelineState, currentStep: "develop" } };
    s = appendEvent(s, {
      kind: "cap-hit",
      at: 2,
      cap,
      reviewRound: 1,
      nextStep: "handoff",
    } as Parameters<typeof appendEvent>[1]);
    const d = nextStep(s);
    assert(d.kind === "step" && d.step === "handoff", `nextStep: cap ${cap} → handoff (develop)`);
    // Same routing for the other two cap-emitting steps.
    for (const step of ["lens-review", "adversarial"] as const) {
      let s2 = initialState(543, 1_000_000);
      s2 = { ...s2, pipelineState: { ...s2.pipelineState, currentStep: step } };
      s2 = appendEvent(s2, {
        kind: "cap-hit",
        at: 2,
        cap,
        reviewRound: 1,
        nextStep: "handoff",
      } as Parameters<typeof appendEvent>[1]);
      const d2 = nextStep(s2);
      assert(
        d2.kind === "step" && d2.step === "handoff",
        `nextStep: cap ${cap} → handoff (${step})`,
      );
    }
  }
}
console.log(`\nexit ${exit}`);
process.exit(exit);
