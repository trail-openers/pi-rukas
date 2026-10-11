#!/usr/bin/env bun
/**
 * #1087 (task-b) — renderer contract for operator-supplied directive items.
 *
 *   - operator items are never count-capped (the cap bounds investigation
 *     items only): ACCEPTANCE CRITERIA, PITFALLS, spike deliverable;
 *   - when the operator supplies ACCEPTANCE CRITERIA they ARE the section;
 *     angle-derived criteria go under "Suggested additional criteria";
 *   - an operator DECOMPOSITION block renders under its own top-level heading
 *     outside Sub-issues, and the angle-derived sub-issue count (validateDraft)
 *     ignores it;
 *   - an empty test-surface renders an explicit status, not an instruction.
 */

import type { OperatorDirectives } from "../src/plan-directives.ts";
import { type AngleFindings, draftSpec } from "../src/plan-draft.ts";
import {
  OPERATOR_ITEM_CEILING,
  TEST_SURFACE_FALLBACK,
  fitDraftToBudget,
  validateDraft,
} from "../src/plan-validate.ts";

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
  testSurface: [],
  decomposition: [],
  neverClaim: [],
};

function angle(name: string, kind: string, texts: string[]): AngleFindings {
  return {
    name,
    ok: true,
    text: `${name} summary`,
    toolUses: texts.map((text) => ({ kind, text, angle: name })),
  };
}

function section(body: string, heading: string, next: string): string {
  const start = body.indexOf(`## ${heading}`);
  const end = body.indexOf(`## ${next}`, start + 1);
  return start < 0 ? "" : body.slice(start, end < 0 ? undefined : end);
}

/** True when `item` is rendered as its own bullet in `sec`. */
function renders(sec: string, item: string): boolean {
  return sec.includes(`- ${item}\n`);
}

// ---------------------------------------------- uncapped operator items

{
  const ops = Array.from({ length: 25 }, (_, i) => `operator criterion ${i}`);
  const r = draftSpec(
    "feature",
    "d",
    [],
    [],
    [],
    [],
    0,
    {
      ...NO_DIRS,
      acceptanceCriteria: ops,
      pitfalls: ops.map((s) => `${s} pit`),
    },
    [],
  );
  const ac = section(r.body, "Acceptance criteria", "References");
  assert(
    ops.every((s) => renders(ac, s)),
    "uncapped: all 25 operator ACCEPTANCE CRITERIA render (none dropped by the 20 cap)",
  );
  const edge = section(r.body, "Edge cases & pitfalls", "Open Questions");
  assert(
    ops.every((s) => edge.includes(`- ${s} pit`)),
    "uncapped: all 25 operator PITFALLS render",
  );
}

{
  const angleItems = Array.from({ length: 25 }, (_, i) => `angle criterion ${i}`);
  const r = draftSpec(
    "feature",
    "d",
    [angle("scoping", "acceptance-criterion", angleItems)],
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  const ac = section(r.body, "Acceptance criteria", "References");
  const rendered = angleItems.filter((s) => renders(ac, s));
  assert(
    rendered.length === 20,
    `cap: investigation ACs still capped at 20 (got ${rendered.length})`,
  );
}

// ------------------------------------ operator ACs suppress angle criteria

{
  const r = draftSpec(
    "feature",
    "d",
    [
      angle("scoping", "acceptance-criterion", [
        "CSV export works for users",
        "extra angle criterion",
      ]),
    ],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, acceptanceCriteria: ["Users can export CSV"] },
    [],
  );
  const ac = section(r.body, "Acceptance criteria", "Suggested additional criteria");
  assert(
    ac.includes("- Users can export CSV") && !ac.includes("CSV export works for users"),
    "AC suppression: angle paraphrase does not sit beside the operator's criterion",
  );
  const sug = section(r.body, "Suggested additional criteria", "References");
  assert(
    sug.includes("- CSV export works for users") && sug.includes("- extra angle criterion"),
    "AC suppression: angle-derived criteria appear under 'Suggested additional criteria'",
  );
  assert(
    validateDraft("feature", r.body, 0).ok,
    "AC suppression: the Acceptance criteria section still satisfies the validator",
  );
}

{
  // No operator ACs → angle criteria stay in the AC section, no suggested heading.
  const r = draftSpec(
    "feature",
    "d",
    [angle("scoping", "acceptance-criterion", ["angle only criterion"])],
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  assert(
    !r.body.includes("## Suggested additional criteria") &&
      section(r.body, "Acceptance criteria", "References").includes("- angle only criterion"),
    "AC suppression: without operator criteria, angle criteria render in the AC section as before",
  );
}

// ------------------------------------------------ DECOMPOSITION render

{
  const r = draftSpec(
    "epic",
    "d",
    [angle("decomposition-surface", "sub-issue", ["the CLI surface"])],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, decomposition: ["split by surface", "keep parser separate"] },
    [],
  );
  const sub = section(r.body, "Sub-issues", "Operator decomposition");
  const opDec = section(r.body, "Operator decomposition", "Context"); // no following section → to end
  assert(
    !sub.includes("split by surface") &&
      opDec.includes("- split by surface") &&
      opDec.includes("- keep parser separate"),
    "DECOMPOSITION: the operator block renders under its own heading, outside Sub-issues",
  );
  assert(
    validateDraft("epic", r.body, 0).ok,
    "DECOMPOSITION: operator constraints do not inflate the angle sub-issue count",
  );
  const pinned = validateDraft("epic", r.body, 0, { pinnedSubIssues: 1 });
  assert(pinned.ok, "DECOMPOSITION: a pin is judged against angle sub-issues only");
}

{
  // Operator decomposition alone (no angle sub-issues) is still no decomposition.
  const r = draftSpec(
    "epic",
    "d",
    [],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, decomposition: ["split by surface"] },
    [],
  );
  assert(
    !validateDraft("epic", r.body, 0).ok,
    "DECOMPOSITION: operator constraints without sub-issue items still fail the epic check",
  );
}

// ------------------------------------------- explicit empty test surface

{
  const r = draftSpec("feature", "d", [], [], [], [], 0, NO_DIRS, []);
  const ts = section(r.body, "Test surface", "Edge cases");
  assert(
    ts.includes("- no test-surface items were produced") && !ts.includes("catalogue the tests"),
    "empty test surface: renders the explicit status line, not the instruction string",
  );
  assert(
    r.body.includes(TEST_SURFACE_FALLBACK),
    "empty test surface: the body renders the TEST_SURFACE_FALLBACK status constant",
  );
}

// ---------------------------------------------------- spike deliverable

{
  const ops = Array.from({ length: 25 }, (_, i) => `operator deliverable ${i}`);
  const r = draftSpec(
    "spike",
    "d",
    [angle("scoping", "acceptance-criterion", [])],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, acceptanceCriteria: ops },
    [],
  );
  const del = section(r.body, "Expected deliverable", "References");
  assert(
    ops.every((s) => renders(del, s)),
    "uncapped: all 25 operator items render in the spike deliverable",
  );
}

// ------------------------------------- operator ceiling and oversized input

{
  const ops = Array.from({ length: OPERATOR_ITEM_CEILING + 5 }, (_, i) => `op item ${i}`);
  const r = draftSpec(
    "feature",
    "d",
    [],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, acceptanceCriteria: ops },
    [],
  );
  const ac = section(r.body, "Acceptance criteria", "References");
  assert(
    renders(ac, ops[OPERATOR_ITEM_CEILING - 1] ?? "") &&
      !renders(ac, ops[OPERATOR_ITEM_CEILING] ?? ""),
    "ceiling: items past OPERATOR_ITEM_CEILING are not rendered",
  );
  assert(
    ac.includes("5 further operator item(s) omitted"),
    "ceiling: the omission is stated in the body, not silent",
  );
}

{
  // Oversized operator input cannot be compacted, so it must halt with a
  // breakdown rather than produce a truncated or silently oversized body.
  const big = Array.from({ length: 100 }, (_, i) => `${i} ${"x".repeat(1000)}`);
  const fitted = fitDraftToBudget((budget) =>
    draftSpec(
      "feature",
      "d",
      [],
      [],
      [],
      [],
      0,
      { ...NO_DIRS, acceptanceCriteria: big },
      [],
      undefined,
      budget,
    ),
  );
  assert(
    "tooLarge" in fitted &&
      fitted.tooLarge === true &&
      fitted.breakdown.includes("Acceptance criteria"),
    "oversized operator ACs: fitDraftToBudget returns tooLarge with a section breakdown",
  );
}

{
  // A short operator set at default budget fits and is not compacted.
  const fitted = fitDraftToBudget((budget) =>
    draftSpec(
      "feature",
      "d",
      [],
      [],
      [],
      [],
      0,
      { ...NO_DIRS, acceptanceCriteria: ["short"] },
      [],
      undefined,
      budget,
    ),
  );
  assert("result" in fitted && fitted.compacted === false, "short operator ACs: fits at stage 0");
}

if (exit === 0) console.log("\n✓ test-plan-operator-render: all assertions passed");
process.exit(exit);
