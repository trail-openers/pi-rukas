#!/usr/bin/env bun
/**
 * plan-prior-context — the operator channel is exempt from the shared
 * child-prompt cap (vipune round 9, 2026-09-10).
 *
 * Root cause of the "negative constraints backfire" report: the shared
 * 2000-char cap head-clipped single-paragraph 4-5k operator contexts, so
 * the operator's rulings (both the "Do NOT emit X" clauses AND the
 * positive facts behind them) never reached any angle child — children
 * REGENERATED the natural-prior claims the operator had ruled out. Not
 * phrase-echo: round 8 emitted a forbidden phrase before it existed
 * anywhere in the session, and the gap gate (which reviews the filed
 * body, where operator context renders uncapped per D2) flagged the
 * contradiction instead of emitting it.
 *
 * Pins: operator entries render WHOLE up to their own 12k cap and first;
 * non-operator entries keep the original 2000 cap and marker byte-exactly;
 * a >12k operator entry clips with a marker naming the operator channel;
 * short inputs render byte-identically to the pre-partition shape; and
 * the child prompts (angle + gate) actually carry the full operator text.
 */

import { anglePromptsFor } from "../src/plan-angles.ts";
import { renderPriorContext } from "../src/plan-prior-context.ts";
import { gapGatePrompt } from "../src/plan-gate-prompt.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const OP_FACT = `The setup: hybrid search is now default. Rankings WILL shift for existing users and the CHANGELOG documents it. Do NOT emit any criterion claiming rankings are identical or that the change is a no-op at default medium. ${"Additional settled rulings and background the children must honour. ".repeat(75)}end-of-operator-context`;
const OP = { source: "context param", fact: OP_FACT };
const VIPUNE = Array.from({ length: 8 }, (_, i) => ({
  source: "vipune",
  fact: `snapshot fact ${i}: ${"v".repeat(400)}`,
}));

{
  assert(OP_FACT.length > 4000 && OP_FACT.length < 6000, `fixture is round-9 sized (${OP_FACT.length})`);
  const r = renderPriorContext([OP, ...VIPUNE]);
  assert(
    r.includes("end-of-operator-context"),
    "operator: a 4-5k single-line context param renders WHOLE (the round-9 tail is present)",
  );
  assert(
    r.includes("Do NOT emit any criterion"),
    "operator: the operator's rulings survive into the child-prompt render",
  );
  assert(
    r.indexOf("[context param]") < r.indexOf("[vipune]"),
    "operator: operator entries render FIRST (authority order)",
  );
  assert(
    r.includes("[truncated]") && r.includes("for child-prompt size (full inventory is in the filed body)"),
    "non-operator: the vipune tail still clips with the legacy marker text byte-exactly",
  );
}

{
  // >12k operator entry: clip-to-fit with a marker naming the channel.
  const big = renderPriorContext([{ source: "context param", fact: "y".repeat(13_000) }]);
  assert(big.includes("…"), "operator overflow: a >12k entry clips (head kept, marker visible)");
  assert(
    big.includes("operator context over 12000"),
    "operator overflow: the truncation marker names the operator channel and its cap",
  );

  // Byte-identity for legacy shapes.
  const short = renderPriorContext([{ source: "issue #4", fact: "small fact" }]);
  assert(short === "- [issue #4] small fact", "legacy: short input renders byte-identically");
  const onlyVipune = renderPriorContext(VIPUNE);
  assert(
    /\d+ item\(s\) (clipped|omitted)/.test(onlyVipune) &&
      !onlyVipune.includes("operator context"),
    "legacy: no-operator input keeps the original cap and marker (no operator wording)",
  );
  assert(renderPriorContext([]) === "", "legacy: empty input renders empty");
}

{
  // End-to-end: the ANGLE child prompt and the GATE prompt carry the full
  // operator context (this is the seam the round-9 children were starved
  // through).
  const prompts = anglePromptsFor("feature", "add a thing in src/thing.ts", [OP, ...VIPUNE], [
    "src/thing.ts",
  ]);
  assert(prompts.length > 0, "e2e: angle prompts built");
  assert(
    prompts.every((p) => p.prompt.includes("end-of-operator-context")),
    "e2e: EVERY angle child prompt carries the full operator context",
  );
  const gate = gapGatePrompt("the drafted body", [], [OP, ...VIPUNE]);
  assert(
    gate.includes("end-of-operator-context"),
    "e2e: the gap-gate prompt carries the full operator context",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
