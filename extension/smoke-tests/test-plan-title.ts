#!/usr/bin/env bun
/**
 * #858 — the plan-title contract (moved from test-plan-gap-parser.ts along
 * the 500-line seam) plus the new invariants that file let it ship broken:
 *
 *   - a short descriptor that fits the 72-char TOTAL budget renders
 *     verbatim after the conventional type prefix (unchanged behaviour),
 *   - a 300-char descriptor yields a title ≤ 72 chars TOTAL (prefix
 *     included), with no "…", ending on a word (the mid-sentence ellipsis
 *     cut — the live defect on #836-#849 — is the regression this pins),
 *   - the degenerate no-boundary case: a single token longer than the budget
 *     is hard-cut WITHOUT an ellipsis (the ellipsis ban must not silently
 *     re-introduce itself in the fallback path).
 *
 * Also carries the D4 operator-typed-field precedence block (moved from
 * test-plan-gap-parser.ts along the same seam).
 */

import {
  PRIOR_CONTEXT_CHILD_PROMPT_CAP,
  draftSpec,
  parseOperatorDirectives,
  renderPriorContext,
} from "../src/plan-draft.ts";
import { planTitle } from "../src/plan-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------- unit: planTitle (moved with the draft)

{
  const t = planTitle("add a start_plan_driver tool for the plan pipeline", "feature");
  assert(t.startsWith("feat: "), `title prefix: ${t}`);
  // #858: a short descriptor that fits the 72-char total budget renders
  // verbatim after the prefix — unchanged by the new derivation.
  assert(
    t === "feat: add a start_plan_driver tool for the plan pipeline",
    "title: a fitting descriptor is unchanged (no clause cut)",
  );
}

// #858: a 300-char descriptor must yield a title ≤ 72 chars TOTAL (including
// the type prefix), no trailing "…", a conventional prefix, and an ending on
// a word.
{
  const long =
    "add a start_plan_driver tool for the plan pipeline in extension; it should gate issue creation behind a compiled seam with a dryRun confirmation and per-phase timings plus structured gap-gate verdicts, discriminated filing failures, and a residual-disclosure union disclosed in the filed body and the operator-visible cap message of the result.";
  assert(long.length >= 300, `fixture is a 300+ char descriptor (${long.length})`);
  const t = planTitle(long, "feature");
  assert(
    t.length <= 72,
    `#858: a 300-char descriptor yields a title ≤ 72 chars TOTAL (${t.length}): ${t}`,
  );
  assert(!t.includes("…"), "#858: no ellipsis anywhere in the derived title");
  assert(t.startsWith("feat: "), "#858: the conventional type prefix is present");
  assert(/[a-z0-9]$/.test(t), `#858: the title ends on a word (got ${JSON.stringify(t)})`);
}

// #858 review: the dangling-fragment strip is ONE-PASS — a descriptor that
// already ends in a connector is not stripped past the intended word
// (the old loop turned "…registers with" into "…registers" and could
// empty a short summary; a loop is also what would eat the legitimately
// complete "…with the plan pipeline").
{
  const t1 = planTitle("the tool registers with", "feature");
  assert(
    t1 === "feat: the tool registers with",
    `#858: a descriptor ending in "with" is not over-stripped (got ${JSON.stringify(t1)})`,
  );
  const t2 = planTitle("add a seam to", "feature");
  assert(
    t2 === "feat: add a seam to",
    `#858: a descriptor ending in "to" is not over-stripped (got ${JSON.stringify(t2)})`,
  );
  const t3 = planTitle("remove the guard of", "chore");
  assert(
    t3 === "chore: remove the guard of",
    `#858: a descriptor ending in "of" is not over-stripped (got ${JSON.stringify(t3)})`,
  );
}

// #858: the degenerate no-boundary case — a single token longer than the
// budget is hard-cut WITHOUT an ellipsis (the primary path's ellipsis ban
// must not silently re-introduce itself here).
{
  const token = `src/${"x".repeat(70)}.ts`;
  const t = planTitle(token, "bug");
  assert(t.length <= 72, `#858: single-token descriptor hard-cut to ≤ 72 (${t.length})`);
  assert(t.startsWith("Bug: "), "#858: single-token title keeps the type prefix");
  assert(!t.includes("…"), "#858: the hard cut carries NO ellipsis");
}

// D4: operator-supplied typed fields take precedence over specialist output.
// (Moved from test-plan-gap-parser.ts along the 500-line seam.)
{
  // All five heading forms must parse: plain, ##, ===, **, and === with parenthetical.
  const directives = parseOperatorDirectives(
    "ACCEPTANCE CRITERIA:\n- the tool registers\n- dryRun never files\n\nPITFALLS:\n- a child killed mid-flight reports toolUses: []\n\nOUT OF SCOPE:\n- the /work driver is unchanged",
  );
  assert(
    directives.acceptanceCriteria.length === 2,
    "D4: ACCEPTANCE CRITERIA block → 2 typed items (plain heading)",
  );
  assert(
    directives.acceptanceCriteria[0] === "the tool registers",
    "first acceptance criterion verbatim",
  );
  assert(directives.pitfalls.length === 1, "D4: PITFALLS block → 1 typed item (plain heading)");
  assert(
    directives.outOfScope.length === 1,
    "D4: OUT OF SCOPE block → 1 typed item (plain heading)",
  );
  const free = parseOperatorDirectives("just some prior context fact");
  assert(
    free.acceptanceCriteria.length === 0 &&
      free.pitfalls.length === 0 &&
      free.outOfScope.length === 0,
    "D4: context without recognized headings stays pure prior context",
  );
  const { body } = draftSpec("feature", "descriptor", [], [], [], [], 0, directives, []);
  const acSection = body.slice(
    body.indexOf("## Acceptance criteria"),
    body.indexOf("## References"),
  );
  assert(
    acSection.includes("the tool registers") && acSection.includes("dryRun never files"),
    "D4: operator ACCEPTANCE CRITERIA block reaches the typed Acceptance criteria section",
  );
  const oos = body.slice(body.indexOf("## Out of scope"));
  assert(
    oos.includes("the /work driver is unchanged"),
    "D4: operator OUT OF SCOPE block reaches the Out of scope section",
  );
  const edge = body.slice(body.indexOf("## Edge cases"));
  assert(
    edge.includes("a child killed mid-flight reports toolUses: []"),
    "D4: operator PITFALLS block reaches the Edge cases section",
  );
}

// --------------------------------- D4: all five heading forms
// (Moved from test-plan-gap-parser.ts along the 500-line seam.)

{
  // --------------------------------- D4: all five heading forms
  // === ACCEPTANCE CRITERIA === — the operator's most common heading form.
  // The trailing === must be consumed by the heading regex, not leaked into
  // the section as an item (negative canary below pins this).
  const eq = parseOperatorDirectives(
    "=== ACCEPTANCE CRITERIA ===\n- criterion one\n- criterion two",
  );
  assert(
    eq.acceptanceCriteria.length === 2,
    `D4: '=== ACCEPTANCE CRITERIA ===' parses (${eq.acceptanceCriteria.length} items)`,
  );
  assert(eq.acceptanceCriteria[0] === "criterion one", "D4: === heading: first item verbatim");

  // **ACCEPTANCE CRITERIA** — bold markdown
  const bold = parseOperatorDirectives("**ACCEPTANCE CRITERIA**\n- criterion bold");
  assert(
    bold.acceptanceCriteria.length === 1,
    `D4: '**ACCEPTANCE CRITERIA**' parses (${bold.acceptanceCriteria.length} items)`,
  );
  assert(bold.acceptanceCriteria[0] === "criterion bold", "D4: ** heading: item verbatim");

  // === ACCEPTANCE CRITERIA (use verbatim) === — parenthetical inside ===
  const paren = parseOperatorDirectives(
    "=== ACCEPTANCE CRITERIA (use verbatim) ===\n- verbatim item",
  );
  assert(
    paren.acceptanceCriteria.length === 1,
    `D4: '=== ACCEPTANCE CRITERIA (use verbatim) ===' parses (${paren.acceptanceCriteria.length} items)`,
  );
  assert(
    paren.acceptanceCriteria[0] === "verbatim item",
    "D4: parenthetical heading: item verbatim",
  );

  // ## ACCEPTANCE CRITERIA — hash heading (already worked before D4, pin it)
  const hash = parseOperatorDirectives("## ACCEPTANCE CRITERIA\n- hash item");
  assert(
    hash.acceptanceCriteria.length === 1,
    `D4: '## ACCEPTANCE CRITERIA' parses (${hash.acceptanceCriteria.length} items)`,
  );

  // *PITFALLS* — single-asterisk italic (was silently dropped before D4)
  const italic = parseOperatorDirectives("*PITFALLS*\n- italic pitfall");
  assert(italic.pitfalls.length === 1, `D4: '*PITFALLS*' parses (${italic.pitfalls.length} items)`);
  assert(italic.pitfalls[0] === "italic pitfall", "D4: * heading: item verbatim");

  // === OUT OF SCOPE === — same form for a different section
  const eqOos = parseOperatorDirectives("=== OUT OF SCOPE ===\n- oos item");
  assert(
    eqOos.outOfScope.length === 1,
    `D4: '=== OUT OF SCOPE ===' parses (${eqOos.outOfScope.length} items)`,
  );

  // Negative canary: the trailing === must NOT be captured as an item.
  // (If the regex didn't consume the right wrapper, '===' would appear as
  // the first 'item' — the old shape.)
  assert(
    !eq.acceptanceCriteria.some((s) => s === "===" || s === "*" || s.includes("===")),
    "D4 canary: trailing wrapper chars are not captured as items",
  );

  // Negative canary: a line that is NOT a heading must not trigger a section
  const notHeading = parseOperatorDirectives(
    "the acceptance criteria are listed below\n- this is prose, not a heading",
  );
  assert(
    notHeading.acceptanceCriteria.length === 0,
    "D4 canary: prose mentioning 'acceptance criteria' does NOT create a section",
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
  assert(
    short.includes("- [vipune] the dispatch seam is in plan-driver.ts"),
    "short: item 1 rendered",
  );
  assert(
    short.includes("- [issue #12 (open)] prior work on the plan pipeline"),
    "short: item 2 rendered",
  );
  assert(!short.includes("[truncated]"), "short: no truncation marker when under the cap");

  // 3. Long context (exceeds the cap) → truncated with a marker, items preserved
  //    in order up to the cap, remainder dropped.
  const longItems: { source: string; fact: string }[] = [];
  for (let i = 0; i < 30; i++) {
    longItems.push({
      source: "vipune",
      fact: `prior context line ${i} — ${"x".repeat(100)} (padding to exceed the cap)`,
    });
  }
  const totalLen = longItems.map((p) => `- [${p.source}] ${p.fact}`).join("\n").length;
  assert(
    totalLen > PRIOR_CONTEXT_CHILD_PROMPT_CAP,
    `precondition: total context (${totalLen} chars) exceeds cap (${PRIOR_CONTEXT_CHILD_PROMPT_CAP})`,
  );
  const long = renderPriorContext(longItems);
  assert(
    long.length <= PRIOR_CONTEXT_CHILD_PROMPT_CAP + 200,
    "long: rendered length is capped (within cap + marker overhead)",
  );
  assert(long.includes("[truncated]"), "long: truncation marker is present");
  assert(long.includes("prior context line 0"), "long: first item is preserved");
  // The last item (line 29) should be dropped — the marker says so.
  const truncatedCount =
    longItems.length - (long.match(/- \[vipune\] prior context line/g) ?? []).length;
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
  const ctxSection = body.slice(
    body.indexOf("## Prior context inventory"),
    body.indexOf("## Technical context"),
  );
  assert(ctxSection.includes("prior context line 0"), "draftSpec: first long item in filed body");
  assert(
    ctxSection.includes("prior context line 29"),
    "draftSpec: last long item (line 29) in filed body — full uncapped context",
  );
  assert(
    !ctxSection.includes("[truncated]"),
    "draftSpec: no truncation marker in the filed body (full context)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
