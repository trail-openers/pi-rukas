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
 * Round 2 (the adversarial lens) found the bound could be defeated three ways,
 * and each has a pin here rather than a comment:
 *
 * 1. `item.angle` was interpolated OUTSIDE every clip and the loop emitted the
 *    first line whole (`shown > 0`), so one item with a 60,000-char angle
 *    rendered a 60k section under an 8,000-char cap. → every slot is clipped
 *    and every line is clipped-to-fit; `droppedSection(...).length <=
 *    DROPPED_SECTION_MAX_CHARS` is asserted EXACTLY, no slack constant.
 * 2. The omission line promised the full list "in the run transcripts
 *    (/runs)" — false, because `/runs` truncates tool args and prunes after 5
 *    days. → the pipeline writes the full list to `.pi/work-state/plan-dropped/` and the
 *    line names that file (or the reopened open-points section, which already
 *    carries the text).
 * 3. The cap is part of the DRAFTED body, not of BODY_BUDGET's 4,096-char
 *    post-fit headroom. → the arithmetic `POST_FIT_APPENDS_MAX_CHARS <=
 *    FORGE_BODY_MAX - BODY_BUDGET` is asserted outright, and a worst-case draft
 *    (section at its cap, other sections just under budget, every post-fit
 *    append present) is shown to file under FORGE_BODY_MAX.
 *
 * Pins: the per-item clip and the whole-section cap; the omission line (count +
 * where the full list lives) and its agreement with the tool result's COMPACTED
 * note; the section keeps its own heading so `bodySectionBreakdown` still names
 * it; every other section's bytes are untouched; and byte-identity when the
 * section is already small (the bound is a no-op below its threshold).
 */

import type { DroppedInvestigationItem } from "../src/plan-draft-conflicts.ts";
import { draftSpec } from "../src/plan-draft.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import {
  DROPPED_ARTIFACT,
  DROPPED_ARTIFACT_DIR,
  DROPPED_ITEM_MAX_CHARS,
  DROPPED_LINE_MAX_CHARS,
  DROPPED_OMISSION_LINE_MAX_CHARS,
  DROPPED_REOPENED_HEADING,
  DROPPED_SECTION_HEADING,
  DROPPED_SECTION_MAX_CHARS,
  DROPPED_SOURCE_MAX_CHARS,
  POST_FIT_APPENDS_MAX_CHARS,
  droppedSectionFrameChars,
} from "../src/plan-dropped-budget.ts";
import { lastDroppedRender } from "../src/plan-dropped-holder.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droppedSection, repointDroppedOmission } from "../src/plan-dropped-section.ts";
import {
  BODY_BUDGET,
  FORGE_BODY_MAX,
  bodySectionBreakdown,
  fitDraftToBudget,
} from "../src/plan-validate.ts";
import {
  forgeStub,
  gatePrompts,
  installForgeStub,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
} from "./plan-test-stubs.ts";

import { assert, droppedFixture, finish } from "./plan-dropped-harness.ts";

// ------------------------------------------------------- the pipeline (stubs)

installForgeStub();
installOfflineVipuneStub();
installNoPlanCacheStub();
process.env.PI_ENSEMBLE_FORGE = "none";

const DESCRIPTOR = "add a start_plan_driver body budget in extension/src/plan-validate.ts";

/**
 * The repo root every pipeline run below is handed.
 *
 * NOT `process.cwd()`: the driver hands its `repoRoot` straight to
 * `finalizeDroppedDisclosure` → `writeDroppedArtifact`, which for this fixture
 * omits 335 of 360 items and so writes a real ~130 KB artifact at
 * `<repoRoot>/.pi/work-state/plan-dropped/<slug>-<runId>.json`. With the source
 * tree as the root, running this test dirtied the checkout — the very condition
 * #1383 moved the artifact under `.pi/work-state/` to keep out of `git status`,
 * and the condition /work's branch step hard-blocks on. A temp root is the same
 * seam `test-plan-dropped-artifact-clean-tree.ts` uses; the harness's own
 * `.gitignore` hides `.pi/work-state/`, so the pin below would not notice the
 * difference — that is why the file it writes to is a temp dir and not a claim.
 */
const REPO_ROOT = await mkdtemp(join(tmpdir(), "plan-dropped-bound-"));

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

/**
 * The dropped list the clashing pipeline run actually produced, rebuilt from
 * the same inputs the dispatch stub fed the angles: `draftSpec` is pure, so
 * running it over these items yields the same `dropped` the pipeline drafted
 * with. This is what lets the size pins measure the RENDERER's output rather
 * than a slice of the body (see the #1451 finding-4 note at the first use).
 */
function clashingDroppedItems(): DroppedInvestigationItem[] {
  const items = Array.from({ length: 120 }, (_, i) => ({
    kind: i % 2 === 0 ? ("edge-case" as const) : ("test-surface-item" as const),
    text: NEG(i),
    angle: "x",
  }));
  const drafted = draftSpec(
    "feature",
    DESCRIPTOR,
    [{ name: "x", ok: true, text: "", toolUses: items }],
    [],
    [],
    [],
    0,
    { acceptanceCriteria: [OP], pitfalls: [], outOfScope: [] },
    [],
  );
  return lastDroppedRender()?.items ?? [];
}

/** The rendered section for a decided dropped list — the only thing the cap governs. */
function sectionOf(items: DroppedInvestigationItem[]): string {
  let shown = 0;
  const s = droppedSection(items, undefined, (n) => {
    shown = n;
  });
  assert(
    shown < items.length,
    `bound: the fixture is large enough that the cap actually fired (${shown} of ${items.length} shown)`,
  );
  return s;
}

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
    REPO_ROOT,
  );
  assert(
    r.filingFailure?.reason !== "body-too-large",
    `dropped: a dropped-dominated draft is fileable (got ${r.filingFailure?.reason})`,
  );
  assert(
    r.spec.length < FORGE_BODY_MAX,
    `dropped: the spec sits under the forge cap (${r.spec.length} < ${FORGE_BODY_MAX})`,
  );
  const start = r.spec.indexOf(DROPPED_SECTION_HEADING);
  assert(start > 0, "dropped: the section is present and still names itself");
  // Measured on `droppedSection`'s OWN output, not on a slice of the filed
  // body (#1451 finding 4): a next-`## `-delimited slice charges the bytes
  // between this heading and `## Open Questions` to this section — and in the
  // pipeline body those bytes are `draftSpec`'s own `## Edge cases & pitfalls`
  // content, so the slice reported 8,022 for a section that renders 6,106. The
  // renderer's return value is the only thing the cap governs.
  const section = sectionOf(clashingDroppedItems());
  assert(
    section.length <= DROPPED_SECTION_MAX_CHARS,
    `dropped: the section is at most the cap, exactly (${section.length} <= ${DROPPED_SECTION_MAX_CHARS})`,
  );
  assert(
    /_\u2026 \d+ further dropped item\(s\) not shown/.test(section),
    "dropped: the omission line is present with its count",
  );
  // The pointer must name something the pipeline actually produced. Round 1
  // named the run transcripts, which truncate tool args and prune after 5
  // days — a promise the body carries for the lifetime of the issue.
  assert(
    section.includes(DROPPED_ARTIFACT_DIR) || section.includes(DROPPED_ARTIFACT),
    "dropped: the omission line names where the full list lives",
  );
  assert(
    !section.includes("/runs"),
    "dropped: the omission line no longer points at the pruned run transcripts",
  );
  const bullets = section.split("\n").filter((l) => l.startsWith("- dropped:"));
  assert(bullets.length > 0, "dropped: kept-disclosure bullets still render (not silenced)");
  assert(
    Math.max(...bullets.map((l) => l.length)) <= DROPPED_LINE_MAX_CHARS,
    `dropped: no single line runs away (${Math.max(...bullets.map((l) => l.length))} chars; line bound ${DROPPED_LINE_MAX_CHARS})`,
  );
  const gate = gatePrompts[0] ?? "";
  assert(
    gate.includes(DROPPED_SECTION_HEADING) && gate.includes("further dropped item(s) not shown"),
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
    REPO_ROOT,
  );
  assert(
    fired.filed === true,
    `dropped: the same draft files (reason ${fired.filingFailure?.reason})`,
  );
  assert(
    forgeStub.created.length === 1 && forgeStub.created[0]?.body.length < FORGE_BODY_MAX,
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
  const r = await runPlanPipeline({} as never, { ...input }, REPO_ROOT);
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
  const r2 = await runPlanPipeline({} as never, { ...input }, REPO_ROOT);
  assert(r2.spec === r.spec, "small: the small-draft body is byte-identical across runs");
}

setPlanDispatch(null);
// `delete`, never `= undefined`: on Bun 1.4 the assignment stores the literal
// string "undefined" (test-env-clear-gate.ts, #997).
delete process.env.PI_ENSEMBLE_FORGE;

// ---------------------------------------------------------------- draftSpec
// The bound holds through the real renderer, across BOTH drop-producing stages
// (conflicts + dedupe) since plan-draft.ts concatenates the two lists.
// The operator directive set is spelled inline rather than importing NO_DIRS from
// test-plan-operator-conflicts.ts — these files stay independent.
// The operator directive set is spelled inline rather than importing NO_DIRS from
// test-plan-operator-conflicts.ts — these files stay independent.
// The operator directive set is spelled inline rather than importing NO_DIRS from
// test-plan-operator-conflicts.ts — these files stay independent.
// The operator directive set is spelled inline rather than importing NO_DIRS from
// test-plan-operator-conflicts.ts — these files stay independent.
{
  const items = Array.from({ length: 120 }, (_, i) => ({
    kind: i % 2 === 0 ? ("edge-case" as const) : ("test-surface-item" as const),
    text: NEG(i),
    angle: "a",
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
  const start = body.indexOf(DROPPED_SECTION_HEADING);
  assert(start > 0, "draft: the dropped section is present for a clashing draft");
  // The renderer's own output again, not a slice of `body` (see the note at the
  // pipeline-level pin): `## Open Questions` is the NEXT heading, so a slice
  // would bill `draftSpec`'s own Edge cases bytes to this section.
  const section = sectionOf(lastDroppedRender()?.items ?? []);
  assert(
    section.length <= DROPPED_SECTION_MAX_CHARS,
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
    s.startsWith(`\n${DROPPED_SECTION_HEADING}\n\n`),
    "bound: the heading is unchanged so the halt's breakdown still names the section",
  );
  const bullets = s.split("\n").filter((l) => l.startsWith("- dropped:"));
  assert(
    bullets.length > 0 && bullets.length < 120,
    `bound: some drops are shown, not all (${bullets.length} of 120)`,
  );
  const longest = Math.max(...bullets.map((b) => b.length));
  assert(
    longest <= DROPPED_LINE_MAX_CHARS,
    `bound: each line is one short item plus the deciding source (${longest} chars, derived line bound ${DROPPED_LINE_MAX_CHARS})`,
  );
  const itemTexts = bullets.map((b) => b.slice(b.lastIndexOf("] ") + 2));
  assert(
    itemTexts.every((t) => t.length <= DROPPED_ITEM_MAX_CHARS),
    `bound: the item text itself never exceeds the clip (${Math.max(...itemTexts.map((t) => t.length))})`,
  );
  const omission = s.split("\n").find((l) => l.startsWith("_\u2026")) ?? "";
  assert(
    /_\u2026 \d+ further dropped item\(s\) not shown/.test(s),
    "bound: the disclosure line states how many further items were dropped",
  );
  assert(
    /not shown \(\d+-char item text, \d+-char deciding source, section capped at \d+ chars\)/.test(
      s,
    ),
    "bound: the disclosure line names the bounds that fired",
  );
  assert(
    omission.length <= DROPPED_OMISSION_LINE_MAX_CHARS,
    `bound: the omission line fits its own derived budget (${omission.length} <= ${DROPPED_OMISSION_LINE_MAX_CHARS})`,
  );
  assert(
    s.includes(DROPPED_ARTIFACT) || s.includes(DROPPED_ARTIFACT_DIR),
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
      `\n${DROPPED_SECTION_HEADING}\n\n- dropped: conflicts with operator decision "an op line" — [a / edge-case] a short dropped item\n`,
    `bound: a small section renders byte-identically to the pre-fix shape (${JSON.stringify(small.slice(-30))})`,
  );
  assert(droppedSection([]) === "", "bound: zero drops still render no section at all");
}

// The temp root is scratch, not a deliverable: removed whichever way the run
// ends, so a failed assertion cannot leave a directory behind.
await rm(REPO_ROOT, { recursive: true, force: true });

process.exit(finish());
