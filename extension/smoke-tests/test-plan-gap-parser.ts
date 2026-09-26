#!/usr/bin/env bun
/**
 * #606 — the gap-gate prompt's parsing contract, unit-tested in isolation.
 *
 * The gap gate's reviewer reply is parsed by `parseGaps` / `parseGapsForTest`
 * in `plan-driver.ts`. The invariants this suite pins:
 *
 *   - only structured `GAP:` markers parse as gaps — bare severity words in
 *     prose are inert (the earlier regex matched them and the gate saw
 *     pseudo-gaps it could never fix),
 *   - the reviewer's own `proposed resolution:` carries through, absent
 *     resolutions keep the default placeholder,
 *   - zero-marker replies return ZERO gaps honestly (the synthetic MEDIUM
 *     fallback is deleted — the loop's review-unparseable branch decides
 *     what zero-plus-no-verdict means; a parse change is a conscious
 *     decision),
 *   - Bug 3 (#606): `draftSpec` renders open questions with a status — items
 *     carried from a prior gate round render as `status: resolved`, fresh ones
 *     as `status: pending`, and the `resolved:` marker itself is stripped.
 *
 * The pipeline-level e2e coverage (gate dispatch, re-injection, cap-hit)
 * lives in `test-plan-tool.ts`; this file owns the pure parsing seam.
 */

import {
  PRIOR_CONTEXT_CHILD_PROMPT_CAP,
  draftSpec,
  extractPlanItems,
  parseOperatorDirectives,
  renderPriorContext,
} from "../src/plan-draft.ts";
import { parseGapsForTest } from "../src/plan-driver.ts";
import { parseGaps as parseGapsFromDriver } from "../src/plan-gaps.ts";
// The gap-gate parsing logic lives in plan-gaps.ts (split from plan-driver.ts).
// Bind under the original name so all call sites below stay unchanged.
const parseGaps = parseGapsFromDriver;
import { GAP_RESOLUTION_PLACEHOLDER } from "../src/plan-gaps.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------- unit: parseGapsForTest (verdict + fallback)

{
  // parseGapsForTest is the seam the driver's gap gate runs on. The old
  // synthetic MEDIUM fallback for zero-marker replies is DELETED (operator
  // bug report 2026-09-09: it flattened "review unreadable" onto the
  // severity ladder, and under CRITICAL-only blocking an unparseable
  // review was guaranteed to pass). Zero gaps is now returned honestly;
  // the LOOP distinguishes clean (verdictParsed) from unreviewed.
  const clean = parseGapsForTest("No issues found.\nVERDICT: READY");
  assert(clean.verdict === "READY", "parseGaps: explicit READY verdict");
  assert(
    clean.verdictParsed === true,
    "parseGaps: verdictParsed is true when a verdict line is present",
  );
  assert(
    clean.gaps.length === 0,
    "parseGaps: a clean reply returns ZERO gaps (no synthetic fallback)",
  );
  const silent = parseGapsForTest("looks good, nothing to flag");
  assert(
    silent.verdict === "READY" && silent.gaps.length === 0,
    "parseGaps: a no-marker no-verdict reply returns zero gaps — the LOOP treats it as unreviewed, never as a finding",
  );
  assert(
    silent.verdictParsed === false,
    "parseGaps: verdictParsed is false when no verdict line present",
  );
  const prose = parseGapsForTest(
    "- CRITICAL — something important is missing\nVERDICT: NEEDS_ITERATION",
  );
  assert(
    prose.verdict === "NEEDS_ITERATION" && prose.gaps.length === 0,
    "parseGaps: bare severity lines without GAP: markers do NOT parse as gaps",
  );
  assert(
    prose.verdictParsed === true,
    "parseGaps: verdictParsed true when NEEDS_ITERATION verdict present",
  );
}

// --------------------------------------- unit: parseGaps (GAP: markers only)

{
  // Structured markers parse with the reviewer's own resolution carried through.
  const r1 = parseGaps(
    "GAP: CRITICAL — no failure-mode criterion — proposed resolution: add the retry criterion\nGAP: HIGH — boundary unnamed\nVERDICT: NEEDS_ITERATION",
  );
  assert(r1.gaps.length === 2, `two GAP: markers parse: ${r1.gaps.length}`);
  assert(r1.gaps[0]?.severity === "CRITICAL", "severity comes from the marker");
  assert(
    r1.gaps[0]?.resolution === "add the retry criterion",
    "reviewer's resolution flows through",
  );
  assert(
    r1.gaps[1]?.resolution === "address during /work plan phase",
    "absent resolution keeps the default placeholder",
  );
  assert(r1.verdict === "NEEDS_ITERATION", "last verdict line wins");

  // Hyphen separator and prose severity words that must NOT parse.
  const r2 = parseGaps(
    "In summary: 0 CRITICAL, 2 HIGH gaps found overall. The HIGH items are listed below.\nGAP: LOW - cosmetic heading nit - proposed resolution: retitle\nVERDICT: READY",
  );
  assert(
    r2.gaps.length === 1,
    `prose severity words do NOT parse (1 GAP: line only): ${r2.gaps.length}`,
  );
  assert(r2.gaps[0]?.severity === "LOW", "hyphen separator accepted");
  assert(r2.verdict === "READY", "READY verdict parsed");

  // The prompt's own example line is inert: it never begins with GAP:.
  const r3 = parseGaps(
    "Example: GAP: CRITICAL — no failure-mode acceptance criterion — proposed resolution: add a criterion\nVERDICT: NEEDS_ITERATION",
  );
  assert(
    r3.gaps.length === 0,
    "the word 'Example:' before GAP: does not match (marker must be at line start)",
  );

  // No markers + a parsed READY verdict: a GENUINE clean — zero gaps, no
  // synthetic fallback (the loop files it and dispositions render '(none)').
  const r4 = parseGaps("Looks fine to me.\nVERDICT: READY");
  assert(
    r4.gaps.length === 0 && r4.verdictParsed === true,
    "no-marker READY reply is a genuine clean: zero gaps, verdict parsed",
  );
}

// --------------------------------- unit: draftSpec status rendering (#639)

{
  // #639 DECISION B (replaces the Bug 3 #606 block, which pinned the
  // string-prefix behaviour that is now deleted): draftSpec renders carried
  // gap decisions from the STRUCTURED resolvedDecisions parameter — a
  // written-back decision renders `status: resolved`, an unwritten one
  // renders `status: open` with `decision owner: operator` — while genuinely
  // open questions (string[]) stay `status: pending` with the PM as decision
  // owner. The `resolved:` string prefix is DEAD: the prefix test is gone
  // from the renderer, so a plain open question that literally begins
  // "resolved: " renders pending, not resolved (the canary below).
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  // Six-lens re-review (PR #640): the writtenBack flag is now PRODUCED BY
  // the write (markWrittenDecisions reads the SpliceOutcome list), not
  // predicted before it. The test must pass a writebackMap for the
  // "written back" case — the map is what the single splice site in
  // draftSpec applies, and the flag is set only if the splice lands.
  const withResolved = draftSpec(
    "feature",
    "descriptor",
    [],
    [],
    ["a fresh open question"],
    [],
    0,
    NO_DIRS,
    [
      {
        description: "missing acceptance criterion",
        resolution: "sharper criterion added to Acceptance criteria",
        writebackHeading: "Acceptance criteria",
      },
    ],
    new Map([
      ["Acceptance criteria", ["(gate resolution) sharper criterion added to Acceptance criteria"]],
    ]),
  );
  const oqSection = withResolved.body.slice(withResolved.body.indexOf("## Open Questions"));
  assert(
    /status: resolved/.test(oqSection),
    "draftSpec: a written-back carried decision renders status: resolved",
  );
  assert(
    /status: pending/.test(oqSection),
    "draftSpec: genuinely open questions still render as status: pending",
  );
  assert(
    oqSection.includes("missing acceptance criterion"),
    "draftSpec: the carried decision's description renders in Open Questions",
  );
  const unwritten = draftSpec("feature", "descriptor", [], [], [], [], 0, NO_DIRS, [
    {
      description: "the boundary is unnamed",
      writtenBack: false,
      resolution: GAP_RESOLUTION_PLACEHOLDER,
    },
  ]);
  const oq2 = unwritten.body.slice(unwritten.body.indexOf("## Open Questions"));
  assert(
    /status: open/.test(oq2),
    "draftSpec: an unwritten carried decision (placeholder resolution) renders status: open",
  );
  assert(
    /decision owner: operator/.test(oq2),
    "draftSpec: the unwritten decision names the operator as decision owner",
  );
  // Canary: the `resolved:` string prefix is DEAD. A plain open question that
  // literally begins "resolved: " must NOT render as status: resolved — the
  // old /\^resolved:\\s*\/i test is gone; status now comes only from the
  // structured parameter.
  const prefixDead = draftSpec(
    "feature",
    "descriptor",
    [],
    [],
    ["resolved: looks like a marker but is just an open question"],
    [],
    0,
    NO_DIRS,
    [],
  );
  const oq3 = prefixDead.body.slice(prefixDead.body.indexOf("## Open Questions"));
  assert(
    !/status: resolved/.test(oq3),
    "canary: a 'resolved:'-prefixed plain open question does NOT render resolved (prefix is dead)",
  );
  assert(/status: pending/.test(oq3), "canary: the prefix-laden plain question renders pending");
}

// ------------------------------------------------- unit: planTitle

// #858: the plan-title contract (short-descriptor verbatim, 300-char ≤72 /
// no "…" / word end, single-token hard cut) is pinned in test-plan-title.ts
// (moved from this file along the 500-line seam).

// ----------------------------------------- structured-output regressions (D1/D3/D4/D7)
//
// The plan driver's Phase-2 children now report items via the report_plan_item
// tool (plan-reporter.ts); the driver reads result.toolUses, not line-split
// prose. These unit tests pin the pure seams (extractPlanItems / parseOperator
// Directives / draftSpec routing); test-plan-tool.ts exercises them end-to-end
// through the dispatch stub.

{
  // D1: structured items are the record. A reply's "Task complete:" preamble,
  // ## headings and ** debris never reach the typed fields — zero tool calls
  // means zero items (fail-closed, no prose parsing).
  const items = extractPlanItems(
    [
      {
        name: "report_plan_item",
        arguments: {
          kind: "acceptance-criterion",
          text: "the new tool registers with the exact TypeBox schema",
          angle: "interfaces-and-contracts",
        },
      },
      {
        name: "report_plan_item",
        arguments: {
          kind: "edge-case",
          text: "a child killed mid-flight reports toolUses: []",
          angle: "reproduction-surface",
        },
      },
      { name: "report_plan_item", arguments: { kind: "bogus-kind", text: "must be dropped" } },
      { name: "other_tool", arguments: { kind: "reference", text: "wrong tool name" } },
      { name: "report_plan_item", arguments: { kind: "reference", text: "   " } },
    ],
    "test-surface",
  );
  assert(
    items.length === 2,
    `extractPlanItems: only valid report_plan_item calls parse (${items.length})`,
  );
  assert(
    items[0]?.kind === "acceptance-criterion" &&
      items[0]?.text === "the new tool registers with the exact TypeBox schema",
    "acceptance-criterion item: text is the tool call's text, not a line-split fragment",
  );
  assert(items[1]?.kind === "edge-case", "edge-case item parses from any angle's tool calls");
  const zero = extractPlanItems([], "test-surface");
  assert(zero.length === 0, "zero tool calls → zero items (no prose fallback into typed fields)");
}
// The all-angles-failed guard test is in test-plan-subissue-reconciliation.ts
// (moved here from this file to stay under the 500-line limit).

console.log(`\nexit ${exit}`);
process.exit(exit);
