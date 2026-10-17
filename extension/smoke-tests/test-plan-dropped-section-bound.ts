#!/usr/bin/env bun
/**
 * #1383 — the `## Dropped investigation items` section is BOUNDED.
 *
 * Split out of test-plan-body-budget.ts along the 500-line cap (AGENTS.md §12),
 * which is the same limit this issue's fix had to respect. The budget-suite
 * cases that needed the pipeline's existing dispatch stub stayed there; this
 * file owns the dropped-section cases end to end.
 *
 * The observed failure: one dry run reported `NOT FILEABLE AS-IS
 * (body-too-large)` with `Dropped investigation items: 56738 chars` in the
 * breakdown while every other section stayed small. The section was the one
 * `draftSpec` never clipped or count-capped, so BOTH `fitDraftToBudget` stages
 * rendered the same 56k and the fitter halted instead of compacting — the
 * compaction pass was a no-op for exactly the section that had grown.
 *
 * Pins: the per-item clip and the whole-section cap; the omission line (count +
 * where the full list lives) and its agreement with the tool result's COMPACTED
 * note; the section keeps its own heading so `bodySectionBreakdown` still names
 * it; every other section's bytes are untouched; and byte-identity when the
 * section is already small (the bound is a no-op below its threshold).
 */

import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import type { DroppedInvestigationItem } from "../src/plan-draft-conflicts.ts";
import { draftSpec } from "../src/plan-draft.ts";
import {
  DROPPED_ITEM_MAX_CHARS,
  DROPPED_SECTION_MAX_CHARS,
} from "../src/plan-dropped-budget.ts";
import { droppedSection } from "../src/plan-dropped-section.ts";
import { FORGE_BODY_MAX, bodySectionBreakdown, fitDraftToBudget } from "../src/plan-validate.ts";
import {
  forgeStub,
  gatePrompts,
  installForgeStub,
  installOfflineVipuneStub,
  installNoPlanCacheStub,
} from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * `n` fully-loaded dropped items — the worst case the renderer can be handed
 * (two 900-char deciding sources clipped to 160 each, plus a 1,200-char item
 * text). The observed 56,738-char section was ~170 of these. Built directly
 * rather than through `draftSpec`'s conflict stages, which re-partition any
 * candidate set handed to them — the render bound is what this pins, not the
 * drop decision (test-plan-operator-conflicts.ts owns that).
 */
function droppedFixture(n: number): DroppedInvestigationItem[] {
  return Array.from({ length: n }, (_, i) => ({
    item: {
      kind: "edge-case",
      text: `${"s".repeat(1200)} item ${i} must never keep unbounded dropped disclosure`,
      angle: `a${i % 3}`,
    },
    against: "s".repeat(900),
    sibling: "s".repeat(900),
    reason: "settled",
  }));
}

/** The reported failure shape: a body whose bytes are almost all dropped items. */
const DROPPED_DOMINATED_BODY = `${droppedSection(droppedFixture(120)).trimStart()}
## Acceptance criteria

- keep me

## Test surface

- keep me too

## Open Questions

- (none)
`;

// ------------------------------------------------------------------- the fit
// A dropped-dominated body must PASS fitDraftToBudget rather than halt. The
// bound is budget-independent, so neither stage can reproduce the 56k render —
// which is why the cap lives outside RenderBudget (plan-dropped-budget.ts).

{
  const fitted = fitDraftToBudget(() => ({ body: DROPPED_DOMINATED_BODY }));
  assert(
    "result" in fitted && !fitted.compacted,
    "fit: a dropped-dominated body fits at stage 0 — no tooLarge halt",
  );
  const breakdown = bodySectionBreakdown(DROPPED_DOMINATED_BODY);
  assert(
    /Dropped investigation items: \d+ chars/.test(breakdown),
    `fit: the breakdown still names the section after the bound (${breakdown.slice(0, 60)}…)`,
  );
}

// ------------------------------------------------------- the pipeline (stubs)

installForgeStub();
installOfflineVipuneStub();
installNoPlanCacheStub();
process.env.PI_ENSEMBLE_FORGE = "none";

const DESCRIPTOR = "add a start_plan_driver body budget in extension/src/plan-validate.ts";

/**
 * The volume driver, produced the way the pipeline produces it: every angle
 * item carries a negation cue and the same topic tokens, so stage 3 of
 * `filterInvestigationConflicts` (unsettled investigation-vs-investigation
 * clash) drops BOTH sides of every pair — not by inflating one item.
 */
const PAD = "abcdefgh".repeat(6);
const NEG = (i: number) =>
  `the dropped renderer must never ${PAD}${i} keep unbounded disclosure in the filed body`;
const OP = `the dropped renderer keeps ${PAD}999 bounded disclosure in the filed body`;
const CLASHING_CONTEXT = `ACCEPTANCE CRITERIA:\n- ${OP}`;

function clashingDispatch() {
  return ((_pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      gatePrompts.push(spec.prompt);
      return Promise.resolve({
        role: "adversarial-developer",
        ok: true,
        text: "VERDICT: READY",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "DUPLICATE_RISK: none",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "prose summary",
      // The reporter's shape: extractPlanItems counts only {name, arguments}
      // calls — bare items extract to zero and the run halts all-angles-failed.
      toolUses: Array.from({ length: 120 }, (_, i) => ({
        name: "report_plan_item",
        arguments: {
          kind: i % 2 === 0 ? "edge-case" : "test-surface-item",
          text: NEG(i),
          angle: "x",
        },
      })),
      ms: 1,
      exitCode: 0,
    });
  }) as never;
}

{
  setPlanDispatch(clashingDispatch());
  gatePrompts.length = 0;

  // (a) dryRun — the observable the reported symptom actually has (the dry-run
  //     head; phase5FilingFailure runs validateFinalSpec on dry runs too).
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, context: CLASHING_CONTEXT, dryRun: true },
    process.cwd(),
  );
  assert(
    r.filingFailure?.reason !== "body-too-large",
    `dropped: a dropped-dominated draft is fileable (got ${r.filingFailure?.reason})`,
  );
  assert(
    r.spec.length < FORGE_BODY_MAX,
    `dropped: the spec sits under the forge cap (${r.spec.length} < ${FORGE_BODY_MAX})`,
  );
  const start = r.spec.indexOf("## Dropped investigation items");
  assert(start > 0, "dropped: the section is present and still names itself");
  const section = r.spec.slice(start, r.spec.indexOf("## Open Questions", start));
  assert(
    section.length <= DROPPED_SECTION_MAX_CHARS + 40,
    `dropped: the section is at most the cap (${section.length} <= ${DROPPED_SECTION_MAX_CHARS})`,
  );
  assert(
    /_\u2026 \d+ further dropped item\(s\) not shown/.test(section),
    "dropped: the omission line is present with its count",
  );
  assert(
    section.includes("run transcripts") && section.includes("/runs"),
    "dropped: the omission line names where the full list lives",
  );
  const bullets = section.split("\n").filter((l) => l.startsWith("- dropped:"));
  assert(bullets.length > 0, "dropped: kept-disclosure bullets still render (not silenced)");
  assert(
    Math.max(...bullets.map((l) => l.length)) <= DROPPED_ITEM_MAX_CHARS + 560,
    `dropped: no single line runs away (${Math.max(...bullets.map((l) => l.length))} chars; item clip ${DROPPED_ITEM_MAX_CHARS})`,
  );
  const gate = gatePrompts[0] ?? "";
  assert(
    gate.includes("## Dropped investigation items") &&
      gate.includes("further dropped item(s) not shown"),
    "dropped: the gap gate reviewed the BOUNDED section plus its omission line",
  );
  assert(
    !gate.includes("s".repeat(400)),
    "dropped: the gate prompt does not carry the uncapped item text",
  );
  assert(r.compacted === undefined, "dropped: the bounded body fits at stage 0 — no compaction");

  // Section-level stability, asserted on WHOLE-BODY substring equality — never
  // on a next-`##`-delimited slice and never against bodySectionBreakdown, which
  // counts heading bytes and re-attributes the dropped section to Edge cases
  // when its heading is absent.
  assert(
    r.spec.includes(`## Acceptance criteria\n\n- ${OP}`),
    "dropped: the operator criterion renders verbatim beside the capped section",
  );
  assert(
    r.spec.includes("## Open Questions") && r.spec.includes("## Test surface"),
    "dropped: the criteria / test-surface / open-points headings are untouched",
  );

  // (b) non-dryRun — the forge stub receives the body, so "still files under
  //     65,536" is an executed fact, not a dry-run inference.
  forgeStub.created.length = 0;
  const fired = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, context: CLASHING_CONTEXT },
    process.cwd(),
  );
  assert(
    fired.filed === true,
    `dropped: the same draft files (reason ${fired.filingFailure?.reason})`,
  );
  assert(
    forgeStub.created.length === 1 && forgeStub.created[0]!.body.length < FORGE_BODY_MAX,
    `dropped: the forge received a body under the cap (${forgeStub.created[0]?.body.length})`,
  );
}

{
  // (c) Byte-identity when the dropped section is already SMALL: the bound is a
  //     no-op below its threshold, not a uniform re-render. The item genuinely
  //     conflicts with the operator line (>= 3 shared content tokens, opposite
  //     polarity) so the section has bytes to render, and all of them are short
  //     enough for the clip never to fire.
  const SMALL_NEG = "the retry budget never keeps a cached verdict unchanged";
  const SMALL_OP = "the retry budget keeps every cached verdict unchanged";
  setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      gatePrompts.push(spec.prompt);
      return Promise.resolve({
        role: "adversarial-developer",
        ok: true,
        text: "VERDICT: READY",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "DUPLICATE_RISK: none",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "prose summary",
      toolUses: [
        { name: "report_plan_item", arguments: { kind: "edge-case", text: SMALL_NEG, angle: "x" } },
      ],
      ms: 1,
      exitCode: 0,
    });
  }) as never);
  gatePrompts.length = 0;
  const input = {
    descriptor: DESCRIPTOR,
    context: `ACCEPTANCE CRITERIA:\n- ${SMALL_OP}`,
    dryRun: true,
  } as const;
  const r = await runPlanPipeline({} as never, { ...input }, process.cwd());
  const droppedLines = r.spec.split("\n").filter((l) => l.startsWith("- dropped:"));
  assert(droppedLines.length > 0, "small: the small draft does have dropped items to render");
  assert(
    !r.spec.includes("further dropped item(s) not shown"),
    "small: no omission line when the section fits — the cap is a no-op below threshold",
  );
  assert(
    droppedLines.every((l) => l.includes(SMALL_NEG)),
    "small: each line carries the item text WHOLE — byte-identical to the pre-fix render",
  );
  // The pre-fix renderer's exact output, captured verbatim as a constant.
  const expectedLine = `- dropped: conflicts with operator decision "${SMALL_OP}" — [x / edge-case] ${SMALL_NEG}`;
  assert(
    r.spec.includes(expectedLine),
    "small: the line matches the pre-fix renderer byte-for-byte",
  );
  assert(r.compacted === undefined, "small: the body is not compacted");
  const r2 = await runPlanPipeline({} as never, { ...input }, process.cwd());
  assert(r2.spec === r.spec, "small: the small-draft body is byte-identical across runs");
}

setPlanDispatch(null);
delete process.env.PI_ENSEMBLE_FORGE;

// ---------------------------------------------------------------- draftSpec
// The bound holds through the real renderer, across BOTH drop-producing stages
// (conflicts + dedupe) since plan-draft.ts concatenates the two lists.
// The operator directive set is spelled inline rather than importing NO_DIRS from
// test-plan-operator-conflicts.ts — these files stay independent.
{
  const items = Array.from({ length: 120 }, (_, i) => ({
    kind: i % 2 === 0 ? ("edge-case" as const) : ("test-surface-item" as const),
    text: NEG(i),
  }));
  const body = draftSpec(
    "feature",
    "d",
    [{ name: "a", ok: true, text: "", toolUses: items }],
    [],
    [],
    [],
    0,
    { acceptanceCriteria: [OP], pitfalls: [], outOfScope: [] },
    [],
  ).body;
  const start = body.indexOf("## Dropped investigation items");
  assert(start > 0, "draft: the dropped section is present for a clashing draft");
  const section = body.slice(start, body.indexOf("## Open Questions", start));
  assert(
    section.length <= DROPPED_SECTION_MAX_CHARS + 120,
    `draft: the section spliced into the body is bounded (${section.length})`,
  );
  assert(
    body.length < FORGE_BODY_MAX,
    `draft: the whole body sits under the forge cap (${body.length} < ${FORGE_BODY_MAX})`,
  );
  // The dropped bytes belong to THIS section: a renderer that forgot its heading
  // would hide them inside `## Edge cases & pitfalls` and misreport the breakdown.
  const gap = body.slice(body.indexOf("## Edge cases & pitfalls"), start).length;
  assert(gap < 4096, `draft: Edge cases does not carry the dropped bytes (${gap} chars)`);
}

// ------------------------------------------------- The renderer's own bounds,
// called directly (the pipeline-level pins are above). One dry run filed nothing
// because this section alone reached 56,738 chars — every other section was
// small — and it was the one section `draftSpec` never clipped or count-capped.
// The per-item clip is the readability bound; the SECTION cap is what makes the
// body fileable (a fully loaded `settled` line carries two 160-char sources plus
// a 200-char item, so a 100-item fixture still renders ~20k).
{
  const src = (n: number) => "s".repeat(n);
  const drop = (i: number) => ({
    item: { kind: "edge-case" as const, text: `${i} ${src(1200)}`, angle: "a" },
    against: src(900),
    sibling: src(900),
    reason: "settled" as const,
  });
  const many = Array.from({ length: 120 }, (_, i) => drop(i));
  const s = droppedSection(many);

  assert(
    s.length <= DROPPED_SECTION_MAX_CHARS,
    `bound: 120 fully-loaded drops render inside the section cap (${s.length} <= ${DROPPED_SECTION_MAX_CHARS})`,
  );
  assert(
    s.startsWith("\n## Dropped investigation items\n\n"),
    "bound: the heading is unchanged so the halt's breakdown still names the section",
  );
  const bullets = s.split("\n").filter((l) => l.startsWith("- dropped:"));
  assert(
    bullets.length > 0 && bullets.length < 120,
    `bound: some drops are shown, not all (${bullets.length} of 120)`,
  );
  const longest = Math.max(...bullets.map((b) => b.length));
  assert(
    longest <= DROPPED_ITEM_MAX_CHARS + 560,
    `bound: each line is one short item plus the deciding source (${longest} chars, item clip ${DROPPED_ITEM_MAX_CHARS})`,
  );
  const itemTexts = bullets.map((b) => b.slice(b.lastIndexOf("] ") + 2));
  assert(
    itemTexts.every((t) => t.length <= DROPPED_ITEM_MAX_CHARS),
    `bound: the item text itself never exceeds the clip (${Math.max(...itemTexts.map((t) => t.length))})`,
  );
  assert(
    /_\u2026 \d+ further dropped item\(s\) not shown/.test(s),
    "bound: the disclosure line states how many further items were dropped",
  );
  assert(
    /not shown \(\d+-char item text, section capped at \d+ chars\)/.test(s),
    "bound: the disclosure line names the bounds that fired",
  );
  assert(
    s.includes("run transcripts") && s.includes("/runs"),
    "bound: the disclosure line names where the full list lives",
  );

  // Small-draft regression: below the cap nothing is added — no disclosure line,
  // and a short item renders exactly as it did before the bound (#1132 wording).
  const small = droppedSection([
    {
      item: { kind: "edge-case", text: "a short dropped item", angle: "a" },
      against: "an op line",
      reason: "operator",
    },
  ]);
  assert(
    small ===
      "\n## Dropped investigation items\n\n- dropped: conflicts with operator decision \"an op line\" — [a / edge-case] a short dropped item\n",
    `bound: a small section renders byte-identically to the pre-fix shape (${JSON.stringify(small.slice(-30))})`,
  );
  assert(droppedSection([]) === "", "bound: zero drops still render no section at all");
}


// ------------------------------------------------------------------- canary
// The operator must be able to find the full list from the tool result alone.
// The body's omission line and plan-tool.ts's COMPACTED note name the same
// location because both read one constant — two literals would drift.
{
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const read = (f: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", "src", f), "utf8");
  assert(
    /export const DROPPED_ARTIFACT = "the run transcripts \(\/runs\)";/.test(
      read("plan-dropped-budget.ts"),
    ),
    "canary: the full-list location is one exported constant",
  );
  assert(
    read("plan-dropped-section.ts").includes("DROPPED_ARTIFACT") &&
      read("plan-tool.ts").includes("DROPPED_ARTIFACT"),
    "canary: the body's omission line and the COMPACTED note name the same location",
  );
  assert(
    !/full findings live in "the run/.test(read("plan-tool.ts")),
    "canary: plan-tool.ts has no competing literal for the findings location",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
