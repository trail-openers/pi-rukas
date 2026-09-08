#!/usr/bin/env bun
/**
 * Prompt contract tests for the /plan gap gate and angle prompts.
 *
 * #664 transposed: the gap-gate prompt's severity legend is calibrated to
 * planning scope (keyed to WHO must decide), the Scope Discipline exclusion
 * list is present, and the VERDICT line matches the CRITICAL-only terminal
 * rule. The angle prompts no longer ask for the detail the gate then
 * demands more of (signatures, path:line).
 *
 * Split from test-plan-gap-gate.ts (which hit the 500-line cap) so both
 * files stay under the hard limit.
 */

import { anglePromptsFor } from "../src/plan-angles.ts";
import { codeIdentifiersIn } from "../src/plan-draft.ts";
import { gapGatePrompt } from "../src/plan-driver.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// -------------------------------------------------
// Gap-gate prompt: the severity legend is calibrated to planning scope
// (keyed to WHO must decide), the Scope Discipline exclusion list is
// present, and the VERDICT line matches the terminal rule. The old
// "implementer will be confused or wrong" HIGH wording was the direct
// invitation to implementation-detail findings.
{
  const gatePrompt = gapGatePrompt(
    "DRAFT SPEC BODY",
    [{ name: "test-surface", ok: true, text: "summary", toolUses: [] }],
    [],
  );
  assert(
    !gatePrompt.includes("implementer will be confused or wrong"),
    "prompt: the old HIGH wording ('implementer will be confused or wrong') is gone",
  );
  assert(/WHO must decide/i.test(gatePrompt), "prompt: the who-decides framing is present");
  assert(
    /the spec commits to two things that contradict/.test(gatePrompt),
    "prompt: CRITICAL is defined as a contradiction or unworkable approach",
  );
  assert(
    /a decision the operator must make because the implementer cannot/.test(gatePrompt),
    "prompt: HIGH is defined as an operator-must-decide boundary",
  );
  assert(
    /changes how the work is organised, not what gets built/.test(gatePrompt),
    "prompt: MEDIUM is defined as organisation, not what gets built",
  );
  assert(
    /Do NOT file a gap/.test(gatePrompt),
    "prompt: the Scope Discipline exclusion block is present",
  );
  assert(
    /a value or constant the implementer will pick/i.test(gatePrompt),
    "prompt: exclusions name a value or constant the implementer will pick",
  );
  assert(
    /exact API or method signature/i.test(gatePrompt),
    "prompt: exclusions name an exact API or method signature",
  );
  assert(
    /an error type or error shape/.test(gatePrompt),
    "prompt: exclusions name an error type or error shape",
  );
  assert(
    /a field list derivable from an existing type/i.test(gatePrompt),
    "prompt: exclusions name a field list derivable from an existing type",
  );
  assert(
    /a test-harness mechanic/i.test(gatePrompt),
    "prompt: exclusions name a test-harness mechanic",
  );
  assert(/exact line numbers/i.test(gatePrompt), "prompt: exclusions name exact line numbers");
  assert(
    /restating a decision the spec already makes/.test(gatePrompt),
    "prompt: exclusions name restating a decision the spec already makes",
  );
  assert(
    gatePrompt.includes("VERDICT: READY  (zero CRITICAL gaps)"),
    "prompt: the VERDICT legend says 'zero CRITICAL gaps' (kept the two-line shape)",
  );
  assert(
    gatePrompt.includes("or\nVERDICT: NEEDS_ITERATION"),
    "prompt: the VERDICT legend keeps the two-line 'or\\nVERDICT: NEEDS_ITERATION' shape",
  );
}

// -------------------------------------------------
// Angle prompts: the investigation angles must not ask for the detail the
// gate then demands more of. The feature interfaces-and-contracts angle
// asks for the contract boundary (which module, which exported interface,
// what crosses it) — paths without line numbers — not signatures. The bug
// affected-code angle asks for path plus symbol name, not path:line.
{
  const ids = codeIdentifiersIn(
    "add a start_plan_driver tool for the plan pipeline in extension/src/plan-tool.ts",
  );
  const featureAngles = anglePromptsFor(
    "feature",
    "add a start_plan_driver tool in extension/src/plan-tool.ts",
    [],
    ids,
  );
  const ifc = featureAngles.find((a) => a.name === "interfaces-and-contracts");
  assert(
    !!ifc,
    "angle: interfaces-and-contracts is dispatched for a feature with code identifiers",
  );
  assert(
    !/:\d+/.test(ifc?.prompt ?? ""),
    "angle: interfaces-and-contracts prompt has no ':NN' line-number pattern",
  );
  assert(
    !/signature/i.test(ifc?.prompt ?? ""),
    "angle: interfaces-and-contracts prompt no longer asks for signatures (case-insensitive)",
  );
  const bugAngles = anglePromptsFor("bug", "the plan driver breaks on a stale verdict", [], []);
  const affected = bugAngles.find((a) => a.name === "affected-code");
  assert(!!affected, "angle: affected-code is dispatched for a bug");
  assert(
    !(affected?.prompt ?? "").includes("path:line"),
    "angle: affected-code prompt no longer asks for 'exact path:line'",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
