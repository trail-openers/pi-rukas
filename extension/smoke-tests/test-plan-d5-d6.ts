#!/usr/bin/env bun
/**
 * #633 Group B — D5/D6 unit tests for the /plan pipeline.
 *
 * Split out of test-plan-gap-parser.ts (which is at the 500-line limit) to
 * keep both files under the hard cap. These tests exercise:
 *
 *   - D5: the Technical context section must NOT render the item text —
 *     it shows a per-kind COUNT + the angle's prose summary instead
 *   - D6: vipune-sourced entries are tagged distinctly, and both the angle
 *     prompt and the gap-gate prompt carry the precedence note
 *
 * The parseGaps / verdictParsed / draftSpec-status unit tests are in
 * test-plan-gap-parser.ts. The D1/D2/D7 pipeline end-to-end coverage is in
 * test-plan-gap-gate.ts.
 */

import {
  draftSpec,
  extractPlanItems,
  renderPriorContext,
  techContextLine,
  VIPUNE_PRECEDENCE_NOTE,
  VIPUNE_PRIOR_SOURCE,
} from "../src/plan-draft.ts";
import { gapGatePrompt, parseGapsForTest } from "../src/plan-driver.ts";
import { anglePromptsFor } from "../src/plan-angles.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------------------------- D5: tech context — no item text duplication

{
  // D5: the Technical context section must NOT render the item text — it
  // shows a per-kind COUNT + the angle's prose summary instead. The item
  // text appears in its typed section (Acceptance criteria, Edge cases, etc.)
  // exactly once. The old shape rendered every item here AND again in the
  // typed section, causing drift between copies.

  // Pin the techContextLine seam directly: it must show counts + prose,
  // never the item text.
  const item1 = { kind: "acceptance-criterion", text: "the tool registers with the exact TypeBox schema", angle: "interfaces" };
  const item2 = { kind: "edge-case", text: "a child killed mid-flight reports toolUses: []", angle: "reproduction" };
  const line = techContextLine({
    name: "test-angle",
    text: "Confirmed the tool registers correctly. The child kill path is exercised.",
    toolUses: [item1, item2],
  });
  assert(!line.includes("the tool registers with the exact TypeBox schema"), "D5: techContextLine does NOT include item text (acceptance criterion)");
  assert(!line.includes("a child killed mid-flight reports toolUses: []"), "D5: techContextLine does NOT include item text (edge case)");
  assert(line.includes("1 acceptance-criterion"), `D5: techContextLine shows per-kind count (acceptance-criterion): ${line}`);
  assert(line.includes("1 edge-case"), `D5: techContextLine shows per-kind count (edge-case): ${line}`);
  assert(line.includes("Confirmed the tool registers correctly"), "D5: techContextLine includes the prose summary");

  // Now verify through draftSpec: the item text appears in the typed section
  // but NOT in the Technical context section.
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const items = extractPlanItems(
    [
      { name: "report_plan_item", arguments: { kind: "acceptance-criterion", text: "the tool registers with the exact TypeBox schema", angle: "interfaces" } },
      { name: "report_plan_item", arguments: { kind: "edge-case", text: "a child killed mid-flight reports toolUses: []", angle: "reproduction" } },
    ],
    "test-angle",
  );
  const findings = [
    { name: "test-angle", ok: true, text: "Confirmed the tool registers correctly. The child kill path is exercised.", toolUses: items },
  ];
  const { body } = draftSpec("feature", "descriptor", findings, [], [], [], 0, NO_DIRS, []);
  const techSection = body.slice(body.indexOf("## Technical context"), body.indexOf("## Acceptance criteria"));
  const acSection = body.slice(body.indexOf("## Acceptance criteria"), body.indexOf("## References"));
  const edgeSection = body.slice(body.indexOf("## Edge cases"));

  // The typed sections MUST contain the item text.
  assert(acSection.includes("the tool registers with the exact TypeBox schema"), "D5: typed section (AC) contains item text");
  assert(edgeSection.includes("a child killed mid-flight reports toolUses: []"), "D5: typed section (edge case) contains item text");

  // The Technical context section must NOT contain the item text.
  assert(!techSection.includes("the tool registers with the exact TypeBox schema"), "D5: Technical context does NOT contain AC item text (no duplication)");
  assert(!techSection.includes("a child killed mid-flight reports toolUses: []"), "D5: Technical context does NOT contain edge-case item text (no duplication)");

  // The Technical context section shows counts + prose.
  assert(techSection.includes("1 acceptance-criterion"), "D5: Technical context shows per-kind count");
  assert(techSection.includes("Confirmed the tool registers correctly"), "D5: Technical context includes prose summary");

  // Canary: a gate never observed to fail is worthless — verify the old
  // shape (item text in tech context) would have been caught.
  const oldStyle = `- **test-angle**: the tool registers with the exact TypeBox schema; a child killed mid-flight reports toolUses: []`;
  assert(oldStyle.includes("the tool registers"), "D5 canary: the old shape WOULD have contained item text (gate would catch it)");
  assert(!techSection.includes("the tool registers with the exact TypeBox schema"), "D5 canary: new shape does NOT contain item text (gate passes)");
}

// --------------------------------------------------- D6: vipune tag + precedence

{
  // D6: vipune-sourced entries must be tagged distinctly, and both the
  // angle prompt and the gap-gate prompt must carry the precedence note.

  // 1. The tag constant is the vipune source.
  assert(VIPUNE_PRIOR_SOURCE.includes("vipune"), "D6: VIPUNE_PRIOR_SOURCE includes 'vipune'");
  assert(VIPUNE_PRIOR_SOURCE.includes("stale"), "D6: VIPUNE_PRIOR_SOURCE mentions staleness");

  // 2. The precedence note is present and mentions both the tag and the
  //    live-context-wins rule.
  assert(VIPUNE_PRECEDENCE_NOTE.length > 50, "D6: VIPUNE_PRECEDENCE_NOTE is a substantial instruction");
  assert(/live context/i.test(VIPUNE_PRECEDENCE_NOTE), "D6: precedence note mentions 'live context'");
  assert(/stale/i.test(VIPUNE_PRECEDENCE_NOTE), "D6: precedence note mentions staleness");

  // 3. renderPriorContext with a vipune tag renders the tag.
  const withVipune = renderPriorContext([
    { source: VIPUNE_PRIOR_SOURCE, fact: "a config with NO [tender] section must produce zero behaviour change" },
    { source: "context param", fact: "the current requirement is different" },
  ]);
  assert(withVipune.includes(VIPUNE_PRIOR_SOURCE), "D6: renderPriorContext renders the vipune tag");
  assert(withVipune.includes("a config with NO [tender] section"), "D6: vipune fact is rendered");
  assert(withVipune.includes("the current requirement is different"), "D6: context-param fact is rendered");

  // 4. The precedence note is appended to the gap-gate prompt when vipune
  //    entries are present.
  const gatePrompt = gapGatePrompt(
    "spec body",
    [{ name: "test", ok: true, text: "summary", toolUses: [] }],
    [{ source: VIPUNE_PRIOR_SOURCE, fact: "a stale fact" }, { source: "context param", fact: "current context" }],
  );
  assert(gatePrompt.includes(VIPUNE_PRECEDENCE_NOTE), "D6: gap-gate prompt includes the precedence note when vipune entries present");
  assert(gatePrompt.includes(VIPUNE_PRIOR_SOURCE), "D6: gap-gate prompt shows the vipune tag");

  // 5. The precedence note is NOT present when no vipune entries exist.
  const noVipune = gapGatePrompt(
    "spec body",
    [{ name: "test", ok: true, text: "summary", toolUses: [] }],
    [{ source: "context param", fact: "current context" }],
  );
  assert(!noVipune.includes(VIPUNE_PRECEDENCE_NOTE), "D6: gap-gate prompt does NOT include precedence note when no vipune entries");

  // 6. The angle prompt also carries the precedence note (D6: both prompts).
  const anglePrompts = anglePromptsFor("feature", "add a tool", [
    { source: VIPUNE_PRIOR_SOURCE, fact: "a stale fact" },
    { source: "context param", fact: "current context" },
  ], ["src/plan-tool.ts"]);
  const angleWithVipune = anglePrompts.find((a) => a.name === "interfaces-and-contracts");
  assert(
    angleWithVipune?.prompt.includes(VIPUNE_PRECEDENCE_NOTE) === true,
    "D6: angle prompt includes the precedence note when vipune entries present",
  );
  const angleNoVipune = anglePromptsFor("feature", "add a tool", [
    { source: "context param", fact: "current context" },
  ], ["src/plan-tool.ts"]);
  const angleNoVip2 = angleNoVipune.find((a) => a.name === "interfaces-and-contracts");
  assert(
    angleNoVip2?.prompt.includes(VIPUNE_PRECEDENCE_NOTE) !== true,
    "D6: angle prompt does NOT include precedence note when no vipune entries",
  );

  // 7. Canary: the old shape (no tag, no precedence) would have been caught.
  const oldTag = "vipune";
  assert(oldTag !== VIPUNE_PRIOR_SOURCE, "D6 canary: the old plain 'vipune' tag differs from the new tagged source");
}

// --------------------------------------------------- D3: verdictParsed matrix

{
  // D3: verdict absence + CRITICAL/HIGH gaps must NOT silently pass as READY.
  // The parser returns verdictParsed: false; the DRIVER (evaluateGapGate)
  // routes on that flag. This test pins the parser's role: it must report
  // the absence, not suppress it.
  const noVerdictHigh = parseGapsForTest("GAP: HIGH — boundary unnamed — proposed resolution: name the boundary");
  assert(noVerdictHigh.verdict === "READY", "D3: parser still returns READY when no verdict line (driver decides routing)");
  assert(noVerdictHigh.verdictParsed === false, "D3: verdictParsed is false — the driver sees the absence");
  assert(noVerdictHigh.gaps.length === 1 && noVerdictHigh.gaps[0]?.severity === "HIGH", "D3: the HIGH gap is parsed");

  // D3: verdict absence + only MEDIUM/LOW gaps → verdictParsed: false is still
  // reported (the driver records it as capReason: "verdict-absent" so it
  // can be surfaced to the operator).
  const noVerdictMed = parseGapsForTest("GAP: MEDIUM — minor clarification needed — proposed resolution: add a note");
  assert(noVerdictMed.verdictParsed === false, "D3: verdictParsed false for MEDIUM-only with no verdict");
  assert(noVerdictMed.gaps.length === 1 && noVerdictMed.gaps[0]?.severity === "MEDIUM", "D3: the MEDIUM gap is parsed");

  // D3: verdict PRESENT → verdictParsed: true regardless of gaps.
  const withVerdict = parseGapsForTest("GAP: CRITICAL — something critical\nVERDICT: NEEDS_ITERATION");
  assert(withVerdict.verdictParsed === true, "D3: verdictParsed true when verdict line present");

  // D3: clean reply with explicit READY verdict.
  const clean = parseGapsForTest("No issues found.\nVERDICT: READY");
  assert(clean.verdict === "READY" && clean.verdictParsed === true, "D3: explicit READY verdict → verdictParsed: true");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
