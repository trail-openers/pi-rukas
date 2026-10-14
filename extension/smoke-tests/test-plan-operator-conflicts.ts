#!/usr/bin/env bun
/**
 * #1132 — operator lines are final. An investigation item that contradicts an
 * operator line is dropped and disclosed BEFORE drafting (lexical, conservative:
 * >= 3 shared content tokens and opposite polarity). The heuristic decides only
 * what is drafted, never what blocks: a gate CRITICAL is never dropped, demoted
 * or discarded by text matching, and at the iteration cap it is an open point.
 */

import type { OperatorDirectives } from "../src/plan-directives.ts";
import {
  droppedDisclosure,
  filterInvestigationConflicts,
  linesConflict,
  operatorLinesOf,
} from "../src/plan-draft-conflicts.ts";
import { dedupeAgainstOperatorLines } from "../src/plan-draft-dedupe.ts";
import { type AngleFindings, VIPUNE_PRIOR_SOURCE, draftSpec } from "../src/plan-draft.ts";
import { runGapGateLoop } from "../src/plan-gaps.ts";
import { gapGatePrompt } from "../src/plan-gate-prompt.ts";
import { OPERATOR_SOURCE } from "../src/plan-prior-context.ts";

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

const OP_AC = "every caller keeps protectedPathsIn unchanged";
const CONFLICTING_EDGE =
  "a caller that changes protectedPathsIn must park the fix pass; no caller keeps using it unchanged";
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
    r.body.includes("dropped: conflicts with operator decision") &&
      r.body.includes(CONFLICTING_EDGE),
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
    [
      angle("edge-cases", [
        { kind: "edge-case", text: a },
        { kind: "edge-case", text: b },
      ]),
    ],
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
    [
      angle("edge-cases", [
        { kind: "edge-case", text: a },
        { kind: "edge-case", text: b },
      ]),
    ],
    [],
    [],
    [],
    0,
    {
      ...NO_DIRS,
      pitfalls: ["the verdict parser must accept bare VERDICT lines, signed off by the operator"],
    },
    [],
  );
  assert(
    r.body.includes(`- ${a}\n`) && !r.body.includes(`- ${b}\n`),
    "settled pair: the negated line is dropped, the positive line kept",
  );
  assert(
    r.body.includes('dropped: operator decision "the verdict parser must accept'),
    "settled pair: the drop names the operator line that settled it",
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
      {
        kind: "test-surface-item",
        text: "no caller keeps protectedPathsIn unchanged after the cycle",
        angle: "t",
      },
      { kind: "out-of-scope", text: "the rubric is out of scope", angle: "o" },
      {
        kind: "out-of-scope",
        text: "a caller keeps protectedPathsIn unchanged in every run",
        angle: "o",
      },
    ],
    [OP_AC],
  );
  assert(
    res.dropped.length === 1 && res.dropped[0]?.item.text.startsWith("no caller"),
    `filter: the negated line contradicts the operator line (dropped ${res.dropped.length})`,
  );
  assert(res.kept.length === 2, "filter: the unrelated line and the positive restatement are kept");
  assert(
    !linesConflict("a plain positive line", "another plain positive line"),
    "polarity: two positive lines do not conflict",
  );
}

// -------------------------------------------------
// 6. #1132 fixtures for the threshold and the polarity cue.
{
  // 401 vs 429: the same response shape, opposite behaviour. Two shared tokens
  // (response, retried) are not enough to call them the same topic: KEPT.
  const op = "a 429 response is retried with backoff";
  const inv = "a 401 response is not retried, it fails at once";
  assert(!linesConflict(op, inv), "401-vs-429: two shared tokens are not a conflict");
  const r = draftSpec(
    "feature",
    "retry policy",
    [angle("edge-cases", [{ kind: "edge-case", text: inv }])],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, acceptanceCriteria: [op] },
    [],
  );
  assert(r.body.includes(`- ${inv}\n`), "401-vs-429: the investigation item is KEPT in the body");
  assert(!r.body.includes("dropped: conflicts with operator decision"), "401-vs-429: no drop");

  // `no-op` is not a negation: the operator line and the investigation line are
  // the same polarity and share the topic, so nothing is dropped.
  const opNoOp = "a 429 response is a no-op for the retry budget";
  const invSpends = "a 429 response spends the retry budget before backing off";
  assert(!linesConflict(opNoOp, invSpends), "no-op: a hyphenated no-op is not a negation cue");
}

// -------------------------------------------------
// 7. The gap gate does NOT discard a CRITICAL that sets an operator line against
//    an investigation line (#1132: a text heuristic never decides blocking). It
//    triggers the corrective round like any CRITICAL and, at the cap, is an open
//    point in the filed body.
{
  const gap =
    "callers must keep protectedPathsIn unchanged versus callers thread a per-cycle set through protectedPathsIn";
  let dispatches = 0;
  const reply = `GAP: CRITICAL — ${gap} — proposed resolution: pick one — resolution-type: operator-decision\nVERDICT: NEEDS_ITERATION`;
  const r = await runGapGateLoop(
    async () => {
      dispatches++;
      return { ok: true, text: reply, toolUses: [] };
    },
    () => "GATE PROMPT",
    1,
    () => {},
  );
  assert(dispatches === 1, `gate: one round at the cap (dispatches=${dispatches})`);
  assert(
    r.capReason === "unresolved-blocking",
    `gate: the CRITICAL reaches the cap (${r.capReason})`,
  );
  assert(
    r.openPoints.length === 1 && (r.openPoints[0]?.description ?? "").includes(gap),
    "gate: the CRITICAL is an open point, not discarded",
  );
}

// -------------------------------------------------
// 8. Two positive, contradictory operator lines ("retry cap is 3" / "retry cap
//    is 5") must end in an open point at the cap, never silently filed.
{
  const gap = "the retry cap is 3 contradicts the retry cap is 5";
  const reply = `GAP: CRITICAL — ${gap} — proposed resolution: pick one — resolution-type: operator-decision\nVERDICT: NEEDS_ITERATION`;
  const r = await runGapGateLoop(
    async () => ({ ok: true, text: reply, toolUses: [] }),
    () => "GATE PROMPT",
    1,
    () => {},
  );
  assert(
    r.openPoints.length === 1 && r.residualForDisclosure.length === 0,
    "retry cap 3 vs 5: an open point at the cap, nothing dropped to the residual",
  );
}

// -------------------------------------------------
// 9. The gap-gate prompt states that operator-authored lines are final.
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

// -------------------------------------------------
// 10. A pair settled by an operator line keeps the side the line agrees with and
//     drops only the other, naming the settling line and the kept sibling.
{
  const agreed = "the verdict parser must accept bare VERDICT lines";
  const negated = "the verdict parser must not accept bare VERDICT lines";
  const op = "the verdict parser must accept bare VERDICT lines, per the operator";
  const res = filterInvestigationConflicts(
    [
      { kind: "edge-case", text: negated, angle: "e" },
      { kind: "edge-case", text: agreed, angle: "e" },
    ],
    [op],
  );
  assert(res.kept.length === 1 && res.kept[0]?.text === agreed, "settled: the agreed side is kept");
  assert(
    res.dropped.length === 1 &&
      res.dropped[0]?.reason === "settled" &&
      res.dropped[0]?.against === op &&
      res.dropped[0]?.sibling === agreed,
    "settled: the dropped side names the operator line and the kept sibling",
  );
  assert(res.openQuestions.length === 0, "settled: no Open Question");
}

// -------------------------------------------------
// 11. An item in several conflicting pairs is dropped and listed once; the
//     operator line settles each pair in favour of the same agreed item.
{
  const agreed = "the verdict parser must accept bare VERDICT lines";
  const negA = "the verdict parser must not accept bare VERDICT lines";
  const negB = "the verdict parser must never accept bare VERDICT lines";
  const res = filterInvestigationConflicts(
    [
      { kind: "edge-case", text: negA, angle: "e" },
      { kind: "edge-case", text: agreed, angle: "e" },
      { kind: "edge-case", text: negB, angle: "e" },
    ],
    [agreed],
  );
  const listed = res.dropped.map((d) => d.item.text);
  assert(
    listed.length === 2 && new Set(listed).size === 2,
    `once: each dropped item is listed once (listed ${listed.length})`,
  );
  assert(
    res.kept.length === 1 && res.kept[0]?.text === agreed,
    "once: the agreed item survives both pairs",
  );
}

// -------------------------------------------------
// 12. A duplicate is disclosed as a duplicate, never as a conflict. The drop
//     cases themselves live in test-plan-draft-dedupe.ts.
{
  const op = "a missing reportVerdict must not return a passing review";
  const restated = "passing review: a missing reportVerdict must not return";
  const res = dedupeAgainstOperatorLines(
    [{ kind: "edge-case", text: restated, angle: "e" }],
    [op],
  );
  const dropped = res.dropped[0];
  assert(
    dropped !== undefined &&
      droppedDisclosure(dropped).includes("duplicate of operator line") &&
      !droppedDisclosure(dropped).includes("conflicts with"),
    "dedupe: disclosed as a duplicate, never as a conflict",
  );
}

// -------------------------------------------------
// 13. The operator tag is one exported constant: operatorLinesOf selects by it.
{
  const lines = operatorLinesOf(NO_DIRS, [
    { source: OPERATOR_SOURCE, fact: OP_AC },
    { source: VIPUNE_PRIOR_SOURCE, fact: "a stale fact" },
  ]);
  assert(
    lines.length === 1 && lines[0] === OP_AC,
    "source: operatorLinesOf selects operator entries via OPERATOR_SOURCE",
  );
}

process.exit(exit);
