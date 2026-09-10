#!/usr/bin/env bun
/**
 * The /plan body budget — specs must fit the forge (vipune session,
 * 2026-09-09: four consecutive filings hit GitHub's 65,536-char issue-body
 * wall AFTER full investigation + a clean gap gate; body size scales with
 * investigation volume and nothing budgeted it).
 *
 * Pins: the two-stage deterministic fit (stage 0 default → one compaction →
 * tooLarge halt with a per-section breakdown); item clipping never touches
 * operator directives or fallback strings; the gap gate reviews the
 * COMPACTED body (what it approves is what files); the corrective re-draft
 * uses the same budget; normal-sized specs render byte-identically to the
 * unbudgeted shape; and byte-determinism across runs.
 */

import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import {
  BODY_BUDGET,
  FORGE_BODY_MAX,
  RENDER_BUDGETS,
  bodySectionBreakdown,
  clipItem,
  fitDraftToBudget,
} from "../src/plan-validate.ts";
import { gatePrompts, installForgeStub } from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------------- units

{
  assert(clipItem("short", 10) === "short", "clipItem: under limit unchanged");
  assert(clipItem("x".repeat(20), 10).length === 10, "clipItem: clipped to limit");
  assert(clipItem("x".repeat(20), 10).endsWith("…"), "clipItem: visible marker");

  const breakdown = bodySectionBreakdown("intro\n## Alpha\naaa\n## Beta\nbb");
  assert(
    /Alpha: \d+ chars/.test(breakdown) && /Beta: \d+ chars/.test(breakdown),
    `breakdown names each section with sizes (${breakdown})`,
  );

  // fitDraftToBudget stages.
  const small = fitDraftToBudget(() => ({ body: "tiny" }));
  assert(
    "result" in small && !small.compacted && small.budget === RENDER_BUDGETS[0],
    "fit: under budget → stage 0, not compacted",
  );
  const shrinks = fitDraftToBudget((b) => ({
    body: b.maxItemsPerSection === 20 ? "x".repeat(BODY_BUDGET + 1) : "now small",
  }));
  assert(
    "result" in shrinks && shrinks.compacted && shrinks.budget === RENDER_BUDGETS[1],
    "fit: over budget → one compaction pass at stage 1",
  );
  const hopeless = fitDraftToBudget(() => ({
    body: `## Prior context inventory\n${"y".repeat(BODY_BUDGET + 10)}`,
  }));
  assert("tooLarge" in hopeless, "fit: over budget after compaction → tooLarge");
  assert(
    "tooLarge" in hopeless && /Prior context inventory: \d+ chars/.test(hopeless.breakdown),
    "fit: the halt carries the per-section breakdown",
  );
}

// ------------------------------------------------------------ pipeline

installForgeStub();
process.env.PI_ENSEMBLE_FORGE = "none";

const LONG_ITEM = `the verify gate must ${"x".repeat(2950)} end`;

function angleReply(itemText: string, perKind: number) {
  const kinds = ["acceptance-criterion", "test-surface-item", "edge-case", "reference", "out-of-scope"];
  const toolUses = kinds.flatMap((kind) =>
    Array.from({ length: perKind }, (_, i) => ({
      name: "report_plan_item",
      arguments: { kind, text: `${kind}-${i}: ${itemText}`, angle: "x" },
    })),
  );
  return { role: "explore", ok: true, text: "prose summary", toolUses, ms: 1, exitCode: 0 };
}

let itemText = LONG_ITEM;
// When set, the FIRST gate call of a pipeline run reports one CRITICAL gap
// (forcing the corrective re-draft + scoped round 2); later calls say READY.
let criticalFirstRound = false;
setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
  if (spec.role === "adversarial-developer") {
    gatePrompts.push(spec.prompt);
    const text =
      criticalFirstRound && gatePrompts.length === 1
        ? "GAP: CRITICAL — no failure-mode criterion — proposed resolution: add the retry criterion\nVERDICT: NEEDS_ITERATION"
        : "VERDICT: READY";
    return Promise.resolve({
      role: "adversarial-developer",
      ok: true,
      text,
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
  return Promise.resolve(angleReply(itemText, 20));
}) as never);

const DESCRIPTOR = "add a start_plan_driver body budget in extension/src/plan-validate.ts";
// Operator context sized so stage 0 (~48k of clipped items) overflows the
// budget but stage 1 (~13k) fits — the compaction case. (Sub-issue lines
// render as text-budget + ~55 chars of checkbox/attribution structure,
// which the 4k BODY_BUDGET headroom absorbs.)
const MID_CONTEXT = Array.from({ length: 40 }, (_, i) => `fact ${i}: ${"c".repeat(600)}`).join("\n");

{
  gatePrompts.length = 0;
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, context: MID_CONTEXT, dryRun: true },
    process.cwd(),
  );
  assert(r.compacted === true, "pipeline: oversized draft compacts (stage 1)");
  assert(
    r.spec.length <= BODY_BUDGET + 300,
    `pipeline: compacted spec fits the budget (${r.spec.length} <= ~${BODY_BUDGET})`,
  );
  assert(
    r.spec.includes("Compacted to fit the forge's 65536-char body limit") ||
      r.spec.includes("Compacted to fit the forge's"),
    "pipeline: the body carries the compaction disclosure line",
  );
  assert(r.spec.includes("…"), "pipeline: clip markers present on clipped items");
  assert(
    (gatePrompts[0] ?? "").includes("Compacted to fit the forge's"),
    "pipeline: the gap gate reviewed the COMPACTED body (what it approves is what files)",
  );
  assert(
    (gatePrompts[0] ?? "").length < FORGE_BODY_MAX,
    "pipeline: the gate prompt stays under the forge cap too (cost fix)",
  );

  // Byte-determinism: identical inputs → identical spec.
  const r2 = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, context: MID_CONTEXT, dryRun: true },
    process.cwd(),
  );
  assert(r2.spec === r.spec, "pipeline: compaction is byte-deterministic across runs");
}

{
  // Halt: an operator context no compaction can absorb.
  const HUGE_CONTEXT = `giant: ${"z".repeat(70_000)}`;
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, context: HUGE_CONTEXT, dryRun: true },
    process.cwd(),
  );
  assert(
    r.filed === false && r.filingFailure?.reason === "body-too-large",
    `halt: body-too-large (got ${r.filingFailure?.reason})`,
  );
  assert(
    /Prior context inventory: \d+ chars/.test(r.filingFailure?.detail ?? ""),
    "halt: the detail's breakdown names the dominant section",
  );
  assert(
    gatePrompts.filter((p) => p.includes("z".repeat(50))).length === 0,
    "halt: pre-gate — no gap-gate dispatch ever saw the oversized body",
  );
}

{
  // Regression: normal-sized items — stage 0, no clip markers, no
  // disclosure, compacted unset.
  itemText = "a normal, self-contained item under the clip";
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, dryRun: true },
    process.cwd(),
  );
  assert(r.compacted === undefined, "regression: normal spec is not compacted");
  assert(!r.spec.includes("Compacted to fit"), "regression: no disclosure line");
  assert(!r.spec.includes("…"), "regression: no clip markers");
  itemText = LONG_ITEM;
}

{
  // Corrective-round budget: a CRITICAL round re-drafts at the SAME chosen
  // budget, so the round-2 body (and gate prompt) stay under the wall too.
  criticalFirstRound = true;
  gatePrompts.length = 0;
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, context: MID_CONTEXT, dryRun: true },
    process.cwd(),
  );
  criticalFirstRound = false;
  assert(r.compacted === true, "corrective: the re-draft is still marked compacted");
  assert(
    r.spec.length <= FORGE_BODY_MAX,
    `corrective: round-2 body stays under the forge cap (${r.spec.length})`,
  );
  assert(gatePrompts.length === 2, `corrective: scoped round 2 ran (${gatePrompts.length} gate calls)`);
  assert(
    (gatePrompts[1] ?? "").length < FORGE_BODY_MAX,
    "corrective: the round-2 gate prompt stays under the forge cap",
  );
}

setPlanDispatch(null);
delete process.env.PI_ENSEMBLE_FORGE;

// Prompt canary: brevity pressure at the source.
{
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const angles = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "plan-angles.ts"),
    "utf8",
  );
  assert(
    /~400 characters/.test(angles) && /clips longer items/.test(angles),
    "canary: the reporter prompt demands ≤~400-char items and warns the clip loses the tail",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
