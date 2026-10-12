#!/usr/bin/env bun
/**
 * #1114 — withParsedSiblings keeps each parsed sibling's findings on the
 * handoff. Each sibling is cut individually, and a cut says how much was
 * dropped, so one long sibling cannot silence the others and no cut is silent.
 */

import { fixRequestEvents, withParsedSiblings } from "../src/work-driver-adversarial-fix.ts";
import type { AdversarialOutcome } from "../src/work-driver-adversarial-types.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const base = {
  rounds: 1,
  records: [{ round: 1, status: "ISSUES_FOUND" as const, verdictParsed: true }],
  infra: false,
  threw: false,
  skipped: false,
  priorInfra: false,
};
const state = {
  pipelineState: { plumbReports: [] },
  eventLog: [],
} as unknown as WorkState;

const long = "x".repeat(4000) + "TAIL-A";
const outcomes: AdversarialOutcome[] = [
  { ...base, id: "a", ok: false, fixRequested: true, fixFindings: long },
  { ...base, id: "b", ok: false, fixRequested: true, fixFindings: "short finding" },
];
const next = withParsedSiblings(state, outcomes, 1);
const body = next.pipelineState.plumbReports?.[0]?.body ?? "";

// A: the long sibling is cut at its own cap, the cut is marked with its size.
assert(!body.includes("TAIL-A"), "A: a long sibling's findings are cut at the cap");
assert(
  body.includes("[truncated: 6 chars omitted]"),
  "A: the cut carries an explicit truncation marker with the size dropped",
);
// B: the short sibling after it is not dropped by the long one's cut.
assert(
  body.includes("[workstream b] ISSUES_FOUND:\nshort finding"),
  "B: a sibling after a long one is kept whole",
);
// C: a sibling under the cap carries no marker.
const short = withParsedSiblings(
  state,
  [{ ...base, id: "c", ok: false, fixRequested: true, fixFindings: "tiny" }],
  1,
);
assert(
  !(short.pipelineState.plumbReports?.[0]?.body ?? "").includes("[truncated"),
  "C: an uncut finding carries no truncation marker",
);

// D: the fix request handed to develop is cut with the same explicit marker, never silently.
const routed = fixRequestEvents(
  [{ id: "a", fixRequested: true, fixFindings: long, records: [{ round: 1 }] }],
  1,
);
const routedText = routed[0]?.kind === "adversarial-fix-requested" ? routed[0].findings : "";
assert(
  routedText.endsWith("[truncated: 6 chars omitted]") && !routedText.includes("TAIL-A"),
  "D: a long fix request is cut at the cap with an explicit truncation marker",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
