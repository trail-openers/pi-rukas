#!/usr/bin/env bun
/**
 * #1114 — withParsedSiblings keeps each parsed sibling's findings on the
 * handoff. Each sibling is cut individually, and a cut says how much was
 * dropped, so one long sibling cannot silence the others and no cut is silent.
 */

import { buildAdversarialPrompt } from "../src/adversarial-prompts.ts";
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

// #1137 — the per-workstream adversarial prompt scopes a docs-only workstream
// to its own declared paths and lists the code sibling's criteria as out of
// scope; a docs-only workstream with a code sibling is NOT asked for the
// sibling's criteria.
{
  const prompt = buildAdversarialPrompt({
    diff: "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-document old\n+document new",
    context: '/work issue #1137: gating diff for workstream "docs" before commit.',
    round: 1,
    maxRounds: 3,
    issueBody:
      "## Acceptance criteria\n- b.txt documents the new flag\n- a.txt implements the feature in src",
    scope: {
      own: { id: "docs", scope: "document the change in b.txt", paths: ["b.txt"] },
      siblings: [{ id: "code", scope: "implement the feature in a.txt", paths: ["a.txt"] }],
    },
  });
  // The scope section is present and names the workstream's own paths.
  assert(
    prompt.includes("WORKSTREAM SCOPE") && prompt.includes("b.txt"),
    "E: the per-workstream prompt carries the workstream's own scope (b.txt)",
  );
  // The sibling is listed as out of scope.
  assert(
    prompt.includes("Out of scope") && prompt.includes('code: "implement the feature in a.txt"'),
    "E: the sibling's criteria are listed as out of scope",
  );
  // The reviewer is told NOT to flag the sibling's criterion.
  assert(
    /do not report them as findings|NOT judged against this diff/i.test(prompt),
    "E: the reviewer is instructed not to flag sibling-owned criteria",
  );
  // N=1 (no scope) is byte-identical to the pre-#1137 prompt shape.
  const n1 = buildAdversarialPrompt({
    diff: "--- a/a.txt\n+++ b/a.txt",
    context: "/work issue #1137: gating diff before commit.",
    round: 1,
    maxRounds: 3,
    issueBody: "## Acceptance criteria\n- a.txt implements the feature",
  });
  assert(
    !n1.includes("WORKSTREAM SCOPE"),
    "E: N=1 has no scope section (byte-identical to pre-#1137)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
