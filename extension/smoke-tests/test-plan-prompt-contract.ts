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
import { inlinePlanPrompt } from "../src/work-driver-prompts-early.ts";

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

// -------------------------------------------------
// #638 — the gap-gate grounding-source third outcome: the CRITICAL legend is
// narrowed to spec-internal contradictions/impossibilities, the UNGROUNDED:
// third-outcome marker is present, the four code-referencing Scope Discipline
// exemptions are conditional (with a positive ungrounded instruction), the
// verify-prompt carries the same third-outcome vocabulary, and the prompt does
// NOT classify the repository (no greenfield/mature detection, no mode flag).
{
  const gatePrompt = gapGatePrompt(
    "DRAFT SPEC BODY",
    [{ name: "test-surface", ok: true, text: "summary", toolUses: [] }],
    [],
  );
  // The old two-trigger CRITICAL definition is gone: the bare "the stated
  // approach cannot work" trigger is what manufactured CRITICALs on
  // greenfield claims about the project's own not-yet-existing code. The new
  // legend keeps the contradiction trigger AND names the internal-
  // impossibility path (checkable from the spec text alone) so the narrowing
  // does not under-fire on a plainly incoherent spec that names no direct
  // contradiction.
  assert(
    !gatePrompt.includes("the stated approach cannot work"),
    "#638: the old second CRITICAL trigger ('the stated approach cannot work') is gone",
  );
  assert(
    /the spec commits to two things that contradict/.test(gatePrompt),
    "#638: the contradiction trigger is still in the CRITICAL legend",
  );
  assert(
    /internally impossible/i.test(gatePrompt),
    "#638: the internal-impossibility path is named (the narrowing does not under-fire)",
  );
  assert(
    /checkable from the spec text alone/i.test(gatePrompt),
    "#638: the CRITICAL legend is keyed to checkability from the spec text alone",
  );
  // The third-outcome vocabulary: UNGROUNDED: is the marker, and it mirrors
  // /work's intent gate (SpecEvidence: confirmed | contradicted | unverifiable).
  assert(
    gatePrompt.includes("UNGROUNDED:"),
    "#638: the UNGROUNDED: third-outcome marker is in the prompt",
  );
  assert(
    /is NOT a gap|are NOT gaps/i.test(gatePrompt),
    "#638: the prompt states UNGROUNDED: lines are NOT gaps",
  );
  // The world-claim path: an external fact the reviewer cannot verify is
  // HIGH (travels in residual disclosure), never CRITICAL.
  assert(
    /claim about THE WORLD/i.test(gatePrompt) || /claim about the world/i.test(gatePrompt),
    "#638: the world-claim path is named (per-claim, not per-repo)",
  );
  assert(
    /NEVER as CRITICAL|never a CRITICAL/i.test(gatePrompt),
    "#638: an unverifiable external fact is never CRITICAL",
  );
  assert(
    /file it as HIGH|file as HIGH/i.test(gatePrompt),
    "#638: an unverifiable external fact is filed as HIGH (travels in residual disclosure)",
  );
  // The four code-referencing Scope Discipline exemptions are now conditional
  // AND carry the positive ungrounded instruction (the spec must commit to
  // creating the type or module). The three non-code-referencing exemptions
  // are unchanged.
  assert(
    /a value or constant the implementer will pick.*resolved against live code.*when the code exists|a value or constant the implementer will pick \(resolved against live code during \/work, when the code exists/i.test(
      gatePrompt,
    ) ||
      gatePrompt.includes(
        "a value or constant the implementer will pick (resolved against live code during /work, when the code exists",
      ),
    "#638: the value/constant exemption is conditional on the code existing",
  );
  assert(
    gatePrompt.includes(
      "an exact API or method signature (the implementer reads the current code, when the code exists",
    ),
    "#638: the API-signature exemption is conditional on the code existing",
  );
  assert(
    /an error type or error shape \(same: the existing types say it, when the types exist/i.test(
      gatePrompt,
    ),
    "#638: the error-type exemption is conditional on the types existing",
  );
  assert(
    /a field list derivable from an existing type \(when the type exists/i.test(gatePrompt),
    "#638: the field-list exemption is conditional on the type existing",
  );
  // The positive ungrounded instruction: when the code does not exist, the
  // spec must commit to creating it. This is what the ticket calls "the spec
  // must commit to creating the type or module" — the exemption is not
  // deleted, it is made conditional.
  assert(
    /the spec must commit to creating/i.test(gatePrompt),
    "#638: the positive ungrounded instruction is present (spec must commit to creating)",
  );
  // The three non-code-referencing exemptions are unchanged.
  assert(
    /a test-harness mechanic/i.test(gatePrompt),
    "#638: the test-harness exemption is unchanged (code-agnostic)",
  );
  assert(
    /exact line numbers/i.test(gatePrompt),
    "#638: the line-numbers exemption is unchanged (code-agnostic)",
  );
  assert(
    /restating a decision the spec already makes/i.test(gatePrompt),
    "#638: the restating-a-decision exemption is unchanged (code-agnostic)",
  );
  // No repository classification: the prompt must NOT classify the repo as
  // greenfield vs mature, and must NOT reference a mode flag or env var.
  assert(
    !/greenfield/i.test(gatePrompt),
    "#638: the prompt does NOT classify the repo as greenfield",
  );
  assert(!/mature repo/i.test(gatePrompt), "#638: the prompt does NOT classify the repo as mature");
  assert(
    !/PI_ENSEMBLE_/.test(gatePrompt),
    "#638: the prompt does NOT reference a mode flag or env var",
  );
  // The verify prompt (round 2) carries the same third-outcome vocabulary —
  // without it the verification round loses the UNGROUNDED: marker and the
  // reviewer reverts to the two-outcome vocabulary.
  const { gapGateVerifyPrompt } = await import("../src/plan-gate-prompt.ts");
  const verifyPrompt = gapGateVerifyPrompt("DRAFT SPEC BODY", [
    {
      description:
        "the spec commits to both a retry cap of 3 and an infinite retry on quota errors",
      resolution: "name which wins",
      writtenBack: true,
      heading: "Acceptance Criteria",
    },
  ]);
  assert(
    verifyPrompt.includes("UNGROUNDED:"),
    "#638: the verify prompt (round 2) carries the UNGROUNDED: marker",
  );
  assert(
    /UNGROUNDED:.*NOT a gap|UNGROUNDED: lines are NOT gaps/i.test(verifyPrompt) ||
      verifyPrompt.includes("do NOT count them toward a severity"),
    "#638: the verify prompt states UNGROUNDED: lines are not gaps",
  );
  assert(
    /never a CRITICAL|NEVER as CRITICAL/i.test(verifyPrompt),
    "#638: the verify prompt keeps the world-claim-never-CRITICAL rule",
  );
}

// -------------------------------------------------
// #679 — the /work driver's inline plan prompt (work-driver-prompts-early.ts
// `inlinePlanPrompt`, the seam the ticket names for the depends-on /
// integration-test line-format assertions) must document BOTH new optional
// workstream lines so the planner is actually told they exist.
{
  const p = inlinePlanPrompt([679], "/tmp/scratch");
  // Both optional workstream lines are documented so the planner is told they
  // exist (the task-prompt workstream's exact wording — leading dash, inline
  // backticks — and task-dep's wording are equivalent; both carry the same
  // contract, so the test asserts on the semantic content, not one worktree's
  // exact punctuation).
  assert(
    /depends-on: <id>/i.test(p),
    "plan-prompt: the `depends-on: <id>` line format is documented",
  );
  assert(
    /integration-test: <path>/i.test(p),
    "plan-prompt: the `integration-test: <path>` line format is documented",
  );
  assert(
    /this workstream\(s\)/i.test(p) || /workstream\(s\)/i.test(p) || /multiple/i.test(p),
    "plan-prompt: the depends-on line is documented (multi-dep supported)",
  );
  assert(
    /REQUIRED/i.test(p) && /interdependent/i.test(p),
    "plan-prompt: the integration-test line is documented as required for interdependent pairs",
  );
  assert(
    /test file exercises the other's file/i.test(p) ||
      /test file covers the other's subject file/i.test(p),
    "plan-prompt: the inferred test-subject coupling is named as a trigger for the integration-test line",
  );
  assert(/N>1/i.test(p), "plan-prompt: both new lines are documented as N>1-only");
  // The pre-existing contract lines are untouched.
  assert(
    p.includes("- paths: <comma-separated touchpoint files>"),
    "plan-prompt: the paths line is still there",
  );
  assert(
    p.includes("- out-of-scope: <comma-separated explicit exclusions — what NOT to touch>"),
    "plan-prompt: the out-of-scope line is still there",
  );
  assert(/ENUMERATE/.test(p), "plan-prompt: the enumerate-first doctrine is still there");
  assert(
    /Bias toward MORE workstreams/i.test(p),
    "plan-prompt: the more-workstreams bias is still there",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
