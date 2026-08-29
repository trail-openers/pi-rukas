#!/usr/bin/env bun
/**
 * #543 F4(i) — explainCap renders a defined trigger line from capEvidence
 * for BOTH cap kinds. The switch is NOT compile-exhaustive: a missing case
 * returns the fallback "step failed: ..." string, so this is the canary.
 * Split from test-work-driver-pr4.ts (AGENTS.md §12 file-size limit).
 */

import { explainCap } from "../src/work-driver-explain.ts";
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
  // (i) explainCap renders a defined (non-undefined) trigger line from
  // capEvidence for both caps. The switch is NOT compile-exhaustive, so the
  // canary is the gate: a missing case returns the fallback "step failed: ..."
  // string rather than the cap-specific sentence.
  for (const [cap, kind, needle] of [
    ["loop-detected", "loop", "looped on"],
    ["token-budget", "token-budget", "token budget"],
  ] as const) {
    let s = initialState(543, 1_000_000);
    s = { ...s, pipelineState: { ...s.pipelineState, currentStep: "handoff" } };
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        // #544 — CapEvidence is a discriminated union: the kind's required
        // fields (count for loop, the budget arithmetic for token-budget)
        // must be present.
        capEvidence:
          kind === "loop"
            ? { kind, count: 10, tool: "bash", fingerprint: "ls /a" }
            : { kind, budgetTokens: 100_000, usedTokens: 110_000 },
      },
    };
    s = appendEvent(s, {
      kind: "cap-hit",
      at: 2,
      cap,
      reviewRound: 1,
      nextStep: "handoff",
    } as Parameters<typeof appendEvent>[1]);
    const line = explainCap(cap, s);
    assert(
      typeof line === "string" && line.includes(needle),
      `explainCap(${cap}) renders the trigger evidence (${needle})`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
