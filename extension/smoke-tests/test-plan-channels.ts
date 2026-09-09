#!/usr/bin/env bun
/**
 * Trusted channels & validation hardening (vipune fixture run, follow-up
 * PR to the disclosure fixes).
 *
 *   C2 — TEST SURFACE and DECOMPOSITION operator directives exist as
 *        structural channels (the injection-defense counterpart: children
 *        never obey quoted instructions, so instructions need a trusted
 *        path); the spike deliverable consumes ACs; a TEST SURFACE
 *        directive REPLACES angle items; spikes with operator input halt
 *        on scaffold strings (the gate never runs for spikes, so the
 *        deterministic bar is the only bar).
 *   C5 — "EXACTLY 5 sub-issues" is parsed, threaded into the
 *        decomposition prompt, and asserted by validateDraft.
 *   C6 — the duplicate-risk prompt distinguishes REVERSAL from DUPLICATE,
 *        reads the operator's acknowledgment via priorContext, and a HIGH
 *        verdict yields a structured duplicate-risk result.
 *   C3 — the gate prompt tells the reviewer skipped/failed angles are
 *        UNINVESTIGATED surface.
 */

import { anglePromptsFor } from "../src/plan-angles.ts";
import { parseOperatorDirectives } from "../src/plan-directives.ts";
import { draftSpec } from "../src/plan-draft.ts";
import { gapGatePrompt } from "../src/plan-gate-prompt.ts";
import { duplicateRiskPrompt } from "../src/plan-investigate.ts";
import {
  SPIKE_DELIVERABLE_FALLBACK,
  TEST_SURFACE_FALLBACK,
  parsePinnedSubIssueCount,
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

const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };

// ------------------------------------------------ directive channels (C2)

{
  const d = parseOperatorDirectives(
    "TEST SURFACE:\n- exactly none — no code shipped\n\nDECOMPOSITION:\n- keep the CLI surface in one sub-issue\n\nSUB-ISSUES\n- another decomposition constraint",
  );
  assert(
    d.testSurface?.length === 1 && d.testSurface[0] === "exactly none — no code shipped",
    "C2: TEST SURFACE heading parses into the testSurface channel",
  );
  assert(
    d.decomposition?.length === 2,
    "C2/C5: DECOMPOSITION and SUB-ISSUES headings both feed the decomposition channel",
  );
  const legacy = parseOperatorDirectives("ACCEPTANCE CRITERIA:\n- the tool registers");
  assert(
    legacy.acceptanceCriteria.length === 1 &&
      legacy.testSurface?.length === 0 &&
      legacy.decomposition?.length === 0,
    "C2: legacy headings unaffected; new channels default empty",
  );
}

{
  // A TEST SURFACE directive REPLACES angle-derived items.
  const findings = [
    {
      name: "test-surface",
      ok: true,
      text: "prose",
      toolUses: [{ kind: "test-surface-item", text: "extend test-foo.ts", angle: "test-surface" }],
    },
  ];
  const withDir = draftSpec(
    "feature",
    "d",
    findings,
    [],
    [],
    [],
    0,
    { ...NO_DIRS, testSurface: ["exactly none — no code shipped"] },
    [],
  );
  const ts = withDir.body.slice(
    withDir.body.indexOf("## Test surface"),
    withDir.body.indexOf("## Edge cases"),
  );
  assert(
    ts.includes("exactly none — no code shipped") && !ts.includes("extend test-foo.ts"),
    "C2: a TEST SURFACE directive REPLACES angle items (never diluted by appends)",
  );

  // Spike deliverable consumes operator ACs.
  const spike = draftSpec(
    "spike",
    "d",
    [{ name: "scoping", ok: true, text: "p", toolUses: [] }],
    [],
    [],
    [],
    0,
    { ...NO_DIRS, acceptanceCriteria: ["a decision memo comparing X and Y"] },
    [],
  );
  assert(
    spike.body.includes("- a decision memo comparing X and Y"),
    "C2: the spike deliverable section consumes operator ACCEPTANCE CRITERIA",
  );
}

// -------------------------------------------- spike validation (C2, hard)

{
  const bare = draftSpec("spike", "d", [{ name: "scoping", ok: true, text: "p", toolUses: [] }], [], [], [], 0, NO_DIRS, []);
  assert(
    validateDraft("spike", bare.body, 0, { operatorSupplied: false }).ok,
    "spike without operator input: scaffold strings are tolerated (status quo)",
  );
  const v = validateDraft("spike", bare.body, 0, { operatorSupplied: true });
  assert(!v.ok, "spike WITH operator input: scaffold deliverable halts (the gate never runs for spikes)");
  assert(
    v.problems.some((p) => p.includes(SPIKE_DELIVERABLE_FALLBACK.slice(0, 10)) || /Expected deliverable/.test(p)),
    "…and the problem names the deliverable section",
  );
  assert(
    v.problems.some((p) => /TEST SURFACE block/.test(p)),
    `…and the test-surface problem points at the trusted channel (fallback: ${TEST_SURFACE_FALLBACK.slice(0, 20)}…)`,
  );
}

// --------------------------------------------------- pinned count (C5)

{
  assert(parsePinnedSubIssueCount("break into EXACTLY 5 sub-issues please") === 5, "C5: pin parses");
  assert(parsePinnedSubIssueCount("exactly 3 sub issues") === 3, "C5: spaced form parses");
  assert(parsePinnedSubIssueCount("about five sub-issues") === undefined, "C5: no numeric pin → undefined");
  assert(parsePinnedSubIssueCount("exactly 99 sub-issues") === undefined, "C5: an insane pin is ignored");

  const findings = (n: number) => [
    {
      name: "decomposition-surface",
      ok: true,
      text: "p",
      toolUses: Array.from({ length: n }, (_, i) => ({
        kind: "sub-issue",
        text: `part ${i + 1}`,
        angle: "decomposition-surface",
      })),
    },
  ];
  const three = draftSpec("epic", "d", findings(3), [], [], [], 0, NO_DIRS, []);
  const vPin = validateDraft("epic", three.body, 0, { pinnedSubIssues: 5 });
  assert(!vPin.ok && /EXACTLY 5/.test(vPin.problems[0] ?? ""), "C5: pin mismatch (3 vs 5) is draft-invalid");
  const five = draftSpec("epic", "d", findings(5), [], [], [], 0, NO_DIRS, []);
  assert(validateDraft("epic", five.body, 0, { pinnedSubIssues: 5 }).ok, "C5: pin match passes");
  assert(validateDraft("epic", three.body, 0, {}).ok, "C5: no pin → count free (ceiling only)");

  const prompts = anglePromptsFor("epic", "an epic", [], [], 5);
  const decomp = prompts.find((p) => p.name === "decomposition-surface");
  assert(
    /EXACTLY 5 sub-issues — produce exactly 5/.test(decomp?.prompt ?? ""),
    "C5: the pin is threaded into the decomposition angle prompt",
  );
}

// ------------------------------------------- duplicate-risk prompt (C6)

{
  const inv = { memory: [], related: [{ number: 103, title: "hybrid default", state: "closed" }], errors: [] };
  const p = duplicateRiskPrompt("chore", "make hybrid the default", inv);
  assert(
    /REVERSAL target, not a duplicate/.test(p) && /report medium at most/.test(p),
    "C6: the prompt distinguishes a closed/landed issue (reversal target) from a duplicate",
  );
  assert(/high means DUPLICATE: an OPEN issue/.test(p), "C6: high is reserved for open/unlanded work");
  const withCtx = duplicateRiskPrompt("chore", "make hybrid the default", inv, [
    { source: "context param", fact: "this deliberately reverses #103 because the 2026 tradeoffs changed" },
  ]);
  assert(
    /RECONCILED and must not raise the risk above medium/.test(withCtx) &&
      withCtx.includes("deliberately reverses #103"),
    "C6: an operator acknowledgment reaches the risk child through priorContext (the no-knob override)",
  );
}

// ------------------------------------------------- gate prompt note (C3)

{
  const g = gapGatePrompt(
    "body",
    [{ name: "interfaces-and-contracts", ok: false, text: "", toolUses: [] }],
    [],
  );
  assert(
    /UNINVESTIGATED — a missing investigation is not evidence of absence/.test(g),
    "C3: the gate prompt weighs skipped/failed angles as uninvestigated surface",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
