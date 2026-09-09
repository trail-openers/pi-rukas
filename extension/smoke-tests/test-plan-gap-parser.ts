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
  draftSpec,
  extractPlanItems,
  parseOperatorDirectives,
  PRIOR_CONTEXT_CHILD_PROMPT_CAP,
  renderPriorContext,
} from "../src/plan-draft.ts";
import { parseGapsForTest, setPlanDispatch } from "../src/plan-driver.ts";
import { parseGaps as parseGapsFromDriver } from "../src/plan-gaps.ts";
// The gap-gate parsing logic lives in plan-gaps.ts (split from plan-driver.ts).
// Bind under the original name so all call sites below stay unchanged.
const parseGaps = parseGapsFromDriver;
import { planTitle } from "../src/plan-types.ts";
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
  assert(clean.verdictParsed === true, "parseGaps: verdictParsed is true when a verdict line is present");
  assert(clean.gaps.length === 0, "parseGaps: a clean reply returns ZERO gaps (no synthetic fallback)");
  const silent = parseGapsForTest("looks good, nothing to flag");
  assert(
    silent.verdict === "READY" && silent.gaps.length === 0,
    "parseGaps: a no-marker no-verdict reply returns zero gaps — the LOOP treats it as unreviewed, never as a finding",
  );
  assert(silent.verdictParsed === false, "parseGaps: verdictParsed is false when no verdict line present");
  const prose = parseGapsForTest("- CRITICAL — something important is missing\nVERDICT: NEEDS_ITERATION");
  assert(
    prose.verdict === "NEEDS_ITERATION" && prose.gaps.length === 0,
    "parseGaps: bare severity lines without GAP: markers do NOT parse as gaps",
  );
  assert(prose.verdictParsed === true, "parseGaps: verdictParsed true when NEEDS_ITERATION verdict present");
}

// --------------------------------------- unit: parseGaps (GAP: markers only)

{
  // Structured markers parse with the reviewer's own resolution carried through.
  const r1 = parseGaps(
    "GAP: CRITICAL — no failure-mode criterion — proposed resolution: add the retry criterion\nGAP: HIGH — boundary unnamed\nVERDICT: NEEDS_ITERATION",
  );
  assert(r1.gaps.length === 2, `two GAP: markers parse: ${r1.gaps.length}`);
  assert(r1.gaps[0]?.severity === "CRITICAL", "severity comes from the marker");
  assert(r1.gaps[0]?.resolution === "add the retry criterion", "reviewer's resolution flows through");
  assert(r1.gaps[1]?.resolution === "address during /work plan phase", "absent resolution keeps the default placeholder");
  assert(r1.verdict === "NEEDS_ITERATION", "last verdict line wins");

  // Hyphen separator and prose severity words that must NOT parse.
  const r2 = parseGaps(
    "In summary: 0 CRITICAL, 2 HIGH gaps found overall. The HIGH items are listed below.\nGAP: LOW - cosmetic heading nit - proposed resolution: retitle\nVERDICT: READY",
  );
  assert(r2.gaps.length === 1, `prose severity words do NOT parse (1 GAP: line only): ${r2.gaps.length}`);
  assert(r2.gaps[0]?.severity === "LOW", "hyphen separator accepted");
  assert(r2.verdict === "READY", "READY verdict parsed");

  // The prompt's own example line is inert: it never begins with GAP:.
  const r3 = parseGaps(
    "Example: GAP: CRITICAL — no failure-mode acceptance criterion — proposed resolution: add a criterion\nVERDICT: NEEDS_ITERATION",
  );
  assert(r3.gaps.length === 0, "the word 'Example:' before GAP: does not match (marker must be at line start)");

  // No markers + a parsed READY verdict: a GENUINE clean — zero gaps, no
  // synthetic fallback (the loop files it and dispositions render '(none)').
  const r4 = parseGaps("Looks fine to me.\nVERDICT: READY");
  assert(r4.gaps.length === 0 && r4.verdictParsed === true, "no-marker READY reply is a genuine clean: zero gaps, verdict parsed");
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
    new Map([["Acceptance criteria", ["sharper criterion added to Acceptance criteria"]]]),
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
  const unwritten = draftSpec(
    "feature",
    "descriptor",
    [],
    [],
    [],
    [],
    0,
    NO_DIRS,
    [
      {
        description: "the boundary is unnamed",
        writtenBack: false,
        resolution: GAP_RESOLUTION_PLACEHOLDER,
      },
    ],
  );
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
  assert(
    /status: pending/.test(oq3),
    "canary: the prefix-laden plain question renders pending",
  );
}

// ------------------------------------------------- unit: planTitle (moved with the draft)

{
  const t = planTitle("add a start_plan_driver tool for the plan pipeline", "feature");
  assert(t.startsWith("feat: "), `title prefix: ${t}`);
}

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
        arguments: { kind: "acceptance-criterion", text: "the new tool registers with the exact TypeBox schema", angle: "interfaces-and-contracts" },
      },
      { name: "report_plan_item", arguments: { kind: "edge-case", text: "a child killed mid-flight reports toolUses: []", angle: "reproduction-surface" } },
      { name: "report_plan_item", arguments: { kind: "bogus-kind", text: "must be dropped" } },
      { name: "other_tool", arguments: { kind: "reference", text: "wrong tool name" } },
      { name: "report_plan_item", arguments: { kind: "reference", text: "   " } },
    ],
    "test-surface",
  );
  assert(items.length === 2, `extractPlanItems: only valid report_plan_item calls parse (${items.length})`);
  assert(
    items[0]?.kind === "acceptance-criterion" &&
      items[0]?.text === "the new tool registers with the exact TypeBox schema",
    "acceptance-criterion item: text is the tool call's text, not a line-split fragment",
  );
  assert(items[1]?.kind === "edge-case", "edge-case item parses from any angle's tool calls");
  const zero = extractPlanItems([], "test-surface");
  assert(zero.length === 0, "zero tool calls → zero items (no prose fallback into typed fields)");
}

{
  // D4: operator-supplied typed fields take precedence over specialist output.
  // All five heading forms must parse: plain, ##, ===, **, and === with parenthetical.
  const directives = parseOperatorDirectives(
    "ACCEPTANCE CRITERIA:\n- the tool registers\n- dryRun never files\n\nPITFALLS:\n- a child killed mid-flight reports toolUses: []\n\nOUT OF SCOPE:\n- the /work driver is unchanged",
  );
  assert(directives.acceptanceCriteria.length === 2, "D4: ACCEPTANCE CRITERIA block → 2 typed items (plain heading)");
  assert(directives.acceptanceCriteria[0] === "the tool registers", "first acceptance criterion verbatim");
  assert(directives.pitfalls.length === 1, "D4: PITFALLS block → 1 typed item (plain heading)");
  assert(directives.outOfScope.length === 1, "D4: OUT OF SCOPE block → 1 typed item (plain heading)");
  const free = parseOperatorDirectives("just some prior context fact");
  assert(
    free.acceptanceCriteria.length === 0 && free.pitfalls.length === 0 && free.outOfScope.length === 0,
    "D4: context without recognized headings stays pure prior context",
  );
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const { body } = draftSpec("feature", "descriptor", [], [], [], [], 0, directives, []);
  const acSection = body.slice(body.indexOf("## Acceptance criteria"), body.indexOf("## References"));
  assert(
    acSection.includes("the tool registers") && acSection.includes("dryRun never files"),
    "D4: operator ACCEPTANCE CRITERIA block reaches the typed Acceptance criteria section",
  );
  const oos = body.slice(body.indexOf("## Out of scope"));
  assert(oos.includes("the /work driver is unchanged"), "D4: operator OUT OF SCOPE block reaches the Out of scope section");
  const edge = body.slice(body.indexOf("## Edge cases"));
  assert(
    edge.includes("a child killed mid-flight reports toolUses: []"),
    "D4: operator PITFALLS block reaches the Edge cases section",
  );
  void NO_DIRS;
}

// --------------------------------- D4: all five heading forms

{
  // === ACCEPTANCE CRITERIA === — the operator's most common heading form.
  // The trailing === must be consumed by the heading regex, not leaked into
  // the section as an item (negative canary below pins this).
  const eq = parseOperatorDirectives("=== ACCEPTANCE CRITERIA ===\n- criterion one\n- criterion two");
  assert(eq.acceptanceCriteria.length === 2, `D4: '=== ACCEPTANCE CRITERIA ===' parses (${eq.acceptanceCriteria.length} items)`);
  assert(eq.acceptanceCriteria[0] === "criterion one", "D4: === heading: first item verbatim");

  // **ACCEPTANCE CRITERIA** — bold markdown
  const bold = parseOperatorDirectives("**ACCEPTANCE CRITERIA**\n- criterion bold");
  assert(bold.acceptanceCriteria.length === 1, `D4: '**ACCEPTANCE CRITERIA**' parses (${bold.acceptanceCriteria.length} items)`);
  assert(bold.acceptanceCriteria[0] === "criterion bold", "D4: ** heading: item verbatim");

  // === ACCEPTANCE CRITERIA (use verbatim) === — parenthetical inside ===
  const paren = parseOperatorDirectives("=== ACCEPTANCE CRITERIA (use verbatim) ===\n- verbatim item");
  assert(paren.acceptanceCriteria.length === 1, `D4: '=== ACCEPTANCE CRITERIA (use verbatim) ===' parses (${paren.acceptanceCriteria.length} items)`);
  assert(paren.acceptanceCriteria[0] === "verbatim item", "D4: parenthetical heading: item verbatim");

  // ## ACCEPTANCE CRITERIA — hash heading (already worked before D4, pin it)
  const hash = parseOperatorDirectives("## ACCEPTANCE CRITERIA\n- hash item");
  assert(hash.acceptanceCriteria.length === 1, `D4: '## ACCEPTANCE CRITERIA' parses (${hash.acceptanceCriteria.length} items)`);

  // *PITFALLS* — single-asterisk italic (was silently dropped before D4)
  const italic = parseOperatorDirectives("*PITFALLS*\n- italic pitfall");
  assert(italic.pitfalls.length === 1, `D4: '*PITFALLS*' parses (${italic.pitfalls.length} items)`);
  assert(italic.pitfalls[0] === "italic pitfall", "D4: * heading: item verbatim");

  // === OUT OF SCOPE === — same form for a different section
  const eqOos = parseOperatorDirectives("=== OUT OF SCOPE ===\n- oos item");
  assert(eqOos.outOfScope.length === 1, `D4: '=== OUT OF SCOPE ===' parses (${eqOos.outOfScope.length} items)`);

  // Negative canary: the trailing === must NOT be captured as an item.
  // (If the regex didn't consume the right wrapper, '===' would appear as
  // the first 'item' — the old shape.)
  assert(!eq.acceptanceCriteria.some((s) => s === "===" || s === "*" || s.includes("===")), "D4 canary: trailing wrapper chars are not captured as items");

  // Negative canary: a line that is NOT a heading must not trigger a section
  const notHeading = parseOperatorDirectives("the acceptance criteria are listed below\n- this is prose, not a heading");
  assert(notHeading.acceptanceCriteria.length === 0, "D4 canary: prose mentioning 'acceptance criteria' does NOT create a section");
}

{
  // D4: sub-issues come from tool calls, not line splits (the old path
  // line-split decomposition prose with minLen=6 + a 4-word blocklist, so
  // junk like "Deps: none" / "## subIssues[]" survived into the spec).
  const subs = extractPlanItems(
    [
      { name: "report_plan_item", arguments: { kind: "sub-issue", text: "Retry backoff config — scope: the retry module" } },
      { name: "report_plan_item", arguments: { kind: "sub-issue", text: "Timeout surfaces — scope: spawn.ts" } },
    ],
    "decomposition-surface",
  );
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const { body } = draftSpec(
    "epic",
    "epic descriptor",
    [
      {
        name: "decomposition-surface",
        ok: true,
        text: "Task complete: decomposed the epic.\n## subIssues[]\n- Retry backoff config\nDeps: none\nOrder: 2",
        toolUses: subs,
      },
    ],
    [],
    [],
    [],
    1,
    NO_DIRS,
    [],
  );
  const subSection = body.slice(body.indexOf("## Sub-issues"));
  assert(
    subSection.includes("Retry backoff config — scope: the retry module"),
    "D4: sub-issue text comes from the tool call (title + scope intact)",
  );
  assert(subSection.includes("Timeout surfaces — scope: spawn.ts"), "D4: second sub-issue from tool call");
  assert(!subSection.includes("Deps: none"), "D4: line-split junk ('Deps: none') does not reach the spec");
  assert(!subSection.includes("## subIssues[]"), "D4: heading debris does not reach the spec");
  assert(!subSection.includes("Task complete:"), "D4: the prose preamble does not reach the spec");
  // #633: the sub-issue prose line-split fallback is DELETED. With the driver's
  // aggregate all-angles-failed guard, this path is unreachable — if zero angles
  // produced structured items, the pipeline halts before draftSpec. So when
  // epicSubIssues has zero sub-issue items, it returns [] and the caller renders
  // the "(decomposition not available)" fallback string. No prose parsing at all.
  const prose = draftSpec(
    "epic",
    "epic descriptor",
    [
      {
        name: "decomposition-surface",
        ok: true,
        text: "## subIssues[]\n- first sub-task one\n- second sub-task two\nDeps: none\nOrder: 2",
        toolUses: [],
      },
    ],
    [],
    [],
    [],
    1,
    NO_DIRS,
    [],
  );
  const proseSection = prose.body.slice(prose.body.indexOf("## Sub-issues"));
  assert(
    proseSection.includes("(decomposition not available)"),
    "#633: zero sub-issue items → '(decomposition not available)' fallback, no prose parsing",
  );
  assert(!proseSection.includes("first sub-task one"), "#633: prose lines do NOT become checkboxes");
  assert(!proseSection.includes("second sub-task two"), "#633: no prose line-split into sub-issues");
  assert(!proseSection.includes("Deps: none"), "#633: no junk in the sub-issues section");
  assert(!proseSection.includes("## subIssues[]"), "#633: no heading debris in the sub-issues section");
}

{
  // D3: edge cases populate for a feature-type plan — the old filter matched
  // only angle names "risk-surface" / "reproduction-surface", so for
  // feature/epic/chore/spike it matched nothing and the fallback string
  // printed even when the operator supplied an explicit pitfalls list.
  const edgeItems = extractPlanItems(
    [
      {
        name: "report_plan_item",
        arguments: { kind: "edge-case", text: "the retry path must not double-fire on provider timeout", angle: "test-surface" },
      },
    ],
    "test-surface",
  );
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const { body } = draftSpec(
    "feature",
    "add a retry path to the plan driver",
    [{ name: "test-surface", ok: true, text: "summary", toolUses: edgeItems }],
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  const edgeSection = body.slice(body.indexOf("## Edge cases"));
  assert(
    edgeSection.includes("the retry path must not double-fire on provider timeout"),
    "D3: edge-case items from ANY angle populate the Edge cases section for a feature plan",
  );
}

// --------------------------------------------------- #633: renderPriorContext cap

{
  // Fix 3 (PERFORMANCE): the prior-context block rendered into CHILD prompts
  // (angle prompts + gap gate) is capped at ~2000 chars TOTAL, not per item.
  // A >2000-char context produces a capped prompt for children with a
  // truncation marker; the full text still reaches draftSpec (the filed body).

  // 1. Empty context → empty string (no header, no marker).
  assert(renderPriorContext([]) === "", "renderPriorContext: empty → empty string");

  // 2. Short context (well under the cap) → rendered in full, no marker.
  const short = renderPriorContext([
    { source: "vipune", fact: "the dispatch seam is in plan-driver.ts" },
    { source: "issue #12 (open)", fact: "prior work on the plan pipeline" },
  ]);
  assert(short.includes("- [vipune] the dispatch seam is in plan-driver.ts"), "short: item 1 rendered");
  assert(short.includes("- [issue #12 (open)] prior work on the plan pipeline"), "short: item 2 rendered");
  assert(!short.includes("[truncated]"), "short: no truncation marker when under the cap");

  // 3. Long context (exceeds the cap) → truncated with a marker, items preserved
  //    in order up to the cap, remainder dropped.
  const longItems: { source: string; fact: string }[] = [];
  for (let i = 0; i < 30; i++) {
    longItems.push({
      source: "context param",
      fact: `prior context line ${i} — ${"x".repeat(100)} (padding to exceed the cap)`,
    });
  }
  const totalLen = longItems.map((p) => `- [${p.source}] ${p.fact}`).join("\n").length;
  assert(totalLen > PRIOR_CONTEXT_CHILD_PROMPT_CAP, `precondition: total context (${totalLen} chars) exceeds cap (${PRIOR_CONTEXT_CHILD_PROMPT_CAP})`);
  const long = renderPriorContext(longItems);
  assert(long.length <= PRIOR_CONTEXT_CHILD_PROMPT_CAP + 200, "long: rendered length is capped (within cap + marker overhead)");
  assert(long.includes("[truncated]"), "long: truncation marker is present");
  assert(long.includes("prior context line 0"), "long: first item is preserved");
  // The last item (line 29) should be dropped — the marker says so.
  const truncatedCount = longItems.length - (long.match(/- \[context param\] prior context line/g) ?? []).length;
  assert(truncatedCount > 0, `long: ${truncatedCount} item(s) truncated`);
  // Post-disclosure-fix marker format: "N item(s) clipped and M item(s)
  // omitted" (an item that fits partially is CLIPPED to the remaining
  // budget rather than dropped whole — the clipped line still counts as
  // kept above, so truncatedCount is the fully-omitted tail).
  assert(
    long.includes(`${truncatedCount} item(s) omitted`),
    "long: the marker states how many items were omitted",
  );
  // Items are preserved in order (the first N fit, the rest are dropped).
  const lineNumbers = [...long.matchAll(/prior context line (\d+)/g)].map((m) => Number(m[1]));
  const isOrdered = lineNumbers.every((n, i) => i === 0 || n > lineNumbers[i - 1]!);
  assert(isOrdered, "long: preserved items are in order (no reordering)");

  // 4. The full unclipped context still reaches draftSpec (the filed body).
  //    draftSpec renders priorContext uncapped — this test confirms the cap
  //    is at the CHILD-PROMPT render site only, not at the filed body.
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const { body } = draftSpec("feature", "descriptor", [], longItems, [], [], 0, NO_DIRS, []);
  const ctxSection = body.slice(body.indexOf("## Prior context inventory"), body.indexOf("## Technical context"));
  assert(ctxSection.includes("prior context line 0"), "draftSpec: first long item in filed body");
  assert(ctxSection.includes("prior context line 29"), "draftSpec: last long item (line 29) in filed body — full uncapped context");
  assert(!ctxSection.includes("[truncated]"), "draftSpec: no truncation marker in the filed body (full context)");
}

// The all-angles-failed guard test is in test-plan-subissue-reconciliation.ts
// (moved here from this file to stay under the 500-line limit).

console.log(`\nexit ${exit}`);
process.exit(exit);
