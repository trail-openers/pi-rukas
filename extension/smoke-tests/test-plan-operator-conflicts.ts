#!/usr/bin/env bun
/**
 * #1132 — operator lines are final. An investigation item that contradicts an
 * operator line is dropped and disclosed BEFORE drafting; the gap gate
 * discards a gap that sets an operator line against an investigation line;
 * an operator-vs-operator clash still caps.
 */

import type { OperatorDirectives } from "../src/plan-directives.ts";
import { type AngleFindings, draftSpec } from "../src/plan-draft.ts";
import {
  filterInvestigationConflicts,
  isOperatorInvestigationGap,
  linesConflict,
} from "../src/plan-draft-conflicts.ts";
import { gapGatePrompt } from "../src/plan-gate-prompt.ts";
import { runGapGateLoop } from "../src/plan-gaps.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const NO_DIRS: OperatorDirectives = {
  acceptanceCriteria: [],
  pitfalls: [],
  outOfScope: [],
};

function angle(name: string, items: { kind: string; text: string }[]): AngleFindings {
  return {
    name,
    ok: true,
    text: "",
    toolUses: items.map((i) => ({ ...i, angle: name })),
  };
}

const OP_AC = "Do not change protectedPathsIn: every caller keeps using it unchanged";
const CONFLICTING_EDGE = "a caller that changes protectedPathsIn must park the fix pass";
const CONSISTENT_EDGE = "an absent config file falls back to the default protected set";

// -------------------------------------------------
// 1. An investigation edge case that contradicts an operator AC is dropped,
//    disclosed, and absent from the drafted body; a consistent one survives.
{
  const r = draftSpec(
    "feature",
    "protected paths",
    [
      angle("edge-cases", [
        { kind: "edge-case", text: CONFLICTING_EDGE },
        { kind: "edge-case", text: CONSISTENT_EDGE },
      ]),
    ],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, acceptanceCriteria: [OP_AC] },
    [],
  );
  assert(
    !r.body.includes(`- ${CONFLICTING_EDGE}\n`),
    "drop: the conflicting edge case is absent from the Edge cases section",
  );
  assert(r.body.includes(CONSISTENT_EDGE), "drop: a non-conflicting edge case still renders");
  assert(
    r.body.includes("dropped: conflicts with operator decision") && r.body.includes(CONFLICTING_EDGE),
    "drop: the dropped item is disclosed with the operator-decision reason",
  );
  assert(r.body.includes(OP_AC), "drop: the operator acceptance criterion is rendered");
}

// -------------------------------------------------
// 2. An operator line is never dropped, even when it "conflicts" with another
//    operator line (operator-vs-operator is not this rule's to resolve).
{
  const opPitfall = "a caller that changes protectedPathsIn must park the fix pass";
  const r = draftSpec(
    "feature",
    "protected paths",
    [],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, acceptanceCriteria: [OP_AC], pitfalls: [opPitfall] },
    [],
  );
  assert(r.body.includes(opPitfall), "operator-only: an operator pitfall is never dropped");
  assert(!r.body.includes("## Dropped investigation items"), "operator-only: no drop section");
}

// -------------------------------------------------
// 3. Two investigation lines that contradict each other, with no operator line
//    about the topic: both dropped, one Open Question.
{
  const a = "the verdict parser must accept bare VERDICT lines";
  const b = "the verdict parser must not accept bare VERDICT lines";
  const r = draftSpec(
    "feature",
    "verdict parsing",
    [angle("edge-cases", [
      { kind: "edge-case", text: a },
      { kind: "edge-case", text: b },
    ])],
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  assert(
    !r.body.includes(`- ${a}\n`) && !r.body.includes(`- ${b}\n`),
    "pair: both contradicting investigation lines dropped",
  );
  assert(
    r.body.includes('Unresolved investigation conflict: "'),
    "pair: an unsettled investigation clash becomes an Open Question",
  );
}

// -------------------------------------------------
// 4. The same pair, but an operator line about the topic settles it: the
//    negated line contradicts the operator line and is dropped citing it, the
//    positive line survives, and NO Open Question is raised.
{
  const a = "the verdict parser must accept bare VERDICT lines";
  const b = "the verdict parser must not accept bare VERDICT lines";
  const r = draftSpec(
    "feature",
    "verdict parsing",
    [angle("edge-cases", [
      { kind: "edge-case", text: a },
      { kind: "edge-case", text: b },
    ])],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, pitfalls: ["the verdict parser is signed off by the operator"] },
    [],
  );
  assert(
    r.body.includes(`- ${a}\n`) && !r.body.includes(`- ${b}\n`),
    "settled pair: the negated line is dropped, the positive line kept",
  );
  assert(
    r.body.includes(`dropped: conflicts with operator decision "the verdict parser is signed off`),
    "settled pair: the drop cites the operator line",
  );
  assert(
    !r.body.includes("Unresolved investigation conflict"),
    "settled pair: operator context settles it — no Open Question",
  );
}

// -------------------------------------------------
// 5. Pure filter: test-surface and out-of-scope kinds are conflictable too.
{
  const res = filterInvestigationConflicts(
    [
      { kind: "test-surface-item", text: "test that callers still change protectedPathsIn", angle: "t" },
      { kind: "out-of-scope", text: "the callers do not keep protectedPathsIn", angle: "o" },
      { kind: "out-of-scope", text: "the rubric is out of scope", angle: "o" },
    ],
    ["every caller keeps protectedPathsIn unchanged"],
  );
  assert(res.dropped.length === 2, `filter: two lines contradict the operator line (got ${res.dropped.length})`);
  assert(res.kept.length === 1 && res.kept[0]?.text === "the rubric is out of scope", "filter: an unrelated line is kept");
  assert(!linesConflict("a plain positive line", "another plain positive line"), "polarity: two positive lines do not conflict");
}

// -------------------------------------------------
// 6. The gap gate discards a gap that sets an operator line against an
//    investigation line: no CRITICAL cap, the gap is disclosed as discarded.
{
  const op = ["every caller keeps protectedPathsIn unchanged"];
  const inv = ["callers thread a per-cycle set through protectedPathsIn"];
  const gap =
    "callers must keep protectedPathsIn unchanged versus callers thread a per-cycle set through protectedPathsIn";
  assert(isOperatorInvestigationGap(gap, op, inv), "gap: an operator-vs-investigation gap is recognised");

  let dispatches = 0;
  const reply = `GAP: CRITICAL — ${gap} — proposed resolution: pick one — resolution-type: operator-decision\nVERDICT: NEEDS_ITERATION`;
  const r = await runGapGateLoop(
    async () => {
      dispatches++;
      return { ok: true, text: reply, toolUses: [] };
    },
    () => "GATE PROMPT",
    3,
    () => {},
    { operatorLines: op, investigationLines: inv },
  );
  assert(dispatches === 1, `gap: the discarded conflict does not iterate (dispatches=${dispatches})`);
  assert(r.gaps.length === 0, "gap: the conflicting CRITICAL is not a blocking gap");
  assert(r.capReason !== "unresolved-blocking", `gap: no CRITICAL cap (capReason=${r.capReason})`);
  assert(r.discardedConflicts.length === 1, "gap: the discarded conflict is recorded");
  assert(
    r.residualForDisclosure.some((g) => g.description.includes(gap)),
    "gap: the discarded conflict is disclosed in the residual section when capped",
  );
}

// -------------------------------------------------
// 7. An operator-vs-operator clash still caps (no discard).
{
  const op = ["do not change protectedPathsIn for callers", "every caller must change protectedPathsIn"];
  const inv = ["callers change protectedPathsIn per cycle"];
  const gap =
    "do not change protectedPathsIn for callers versus every caller must change protectedPathsIn — callers change per cycle";
  assert(!isOperatorInvestigationGap(gap, op, inv), "op-vs-op: a clash between two operator lines is not discarded");

  const reply = `GAP: CRITICAL — ${gap} — proposed resolution: pick one — resolution-type: operator-decision\nVERDICT: NEEDS_ITERATION`;
  const r = await runGapGateLoop(
    async () => ({ ok: true, text: reply, toolUses: [] }),
    () => "GATE PROMPT",
    1,
    () => {},
    { operatorLines: op, investigationLines: inv },
  );
  assert(r.capReason === "unresolved-blocking", `op-vs-op: still caps (capReason=${r.capReason})`);
  assert(r.discardedConflicts.length === 0, "op-vs-op: nothing discarded");
}

// -------------------------------------------------
// 8. The gap-gate prompt states that operator-authored lines are final.
{
  const p = gapGatePrompt("body", [], [{ source: "context param", fact: OP_AC }]);
  assert(
    p.includes("OPERATOR-AUTHORED LINES ARE FINAL"),
    "prompt: the gate prompt states operator-authored lines are final",
  );
  assert(
    p.includes("a conflict between an operator-authored line"),
    "prompt: an operator-vs-investigation conflict is not a gap",
  );
}

process.exit(exit);
