#!/usr/bin/env bun
/**
 * #1827 round 4 — the stop's own two structural invariants that are not about
 * the END of the child but about what it REPORTS: the accumulator is bounded (it
 * is the result the spawn reports, so a 400-turn child must not be held in memory
 * whole), and its text passes through the model-adapter artifact filter
 * `collapseEvents` uses, so a GLM "None" block never reaches `result.text`.
 *
 * Companions: `test-review-post-verdict-result.ts` (the clean-end consumer sweep
 * and the opt-in/stand-down rules) and `test-review-post-verdict-freeze.ts` (the
 * freeze), `test-review-post-verdict.ts` (the block rules). Split for the 500-line
 * file cap (AGENTS.md §12).
 *
 * Offline: pure functions. Nothing spawns.
 */

import { parseVerdict } from "../src/adversarial-verdict.ts";
import type { PiContentBlock, PiJsonEvent } from "../src/pi-event-shapes.ts";
import { createVerdictStop } from "../src/review-bounds.ts";
import { VERDICT_ACCUMULATION_BUDGET } from "../src/review-bounds-verdict.ts";
import { applyReviewBounds } from "../src/spawn-review-bounds.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function text(t: string): PiContentBlock {
  return { type: "text", text: t };
}
function turn(...blocks: PiContentBlock[]): PiJsonEvent {
  return { type: "message_end", message: { role: "assistant", content: blocks } } as PiJsonEvent;
}
function baseResult(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "adversarial-developer",
    ok: true,
    text: "VERDICT: APPROVED",
    toolUses: [],
    ms: 1000,
    exitCode: 0,
    ...over,
  } as DispatchResult;
}

// ── (11) #1827 round 4 — the accumulator is bounded, and its text passes
// through the model-adapter filter `collapseEvents` uses.
{
  // A GLM "None" placeholder must never reach the frozen reply. The adapter is
  // chosen by the message's own `model`, the same lookup collapseEvents makes.
  const glm = createVerdictStop();
  glm.observe({
    type: "message_end",
    message: {
      role: "assistant",
      model: "zai-glm-4.7",
      provider: "cerebras",
      content: [text("Findings."), text("None"), text("null"), text("VERDICT: APPROVED")],
    },
  } as PiJsonEvent);
  assert(glm.status() === "APPROVED", "a GLM reply still stops on its verdict");
  assert(!glm.text().includes("None"), "the placeholder never reaches result.text");
  assert(!/\bnull\b/.test(glm.text()), "…nor the repr-of-null spelling");
  assert(glm.text().includes("Findings."), "…while the real prose survives");
  // Same blocks, non-GLM model: the default adapter drops nothing.
  const plain = createVerdictStop();
  plain.observe(turn(text("Findings."), text("None"), text("VERDICT: APPROVED")));
  assert(plain.text().includes("None"), "a non-GLM reply keeps a literal None block");

  // The budget: a 400-turn child at 80M tokens must not be held in memory just
  // because the accumulator is also the reported result.
  const big = createVerdictStop();
  const chunk = "x".repeat(8 * 1024);
  for (let i = 0; i < 200; i++) big.observe(turn(text(chunk)));
  assert(big.status() === undefined, "an oversized prose stream stops nothing");
  assert(
    big.text().length <= VERDICT_ACCUMULATION_BUDGET,
    `the accumulation is capped at the budget (${big.text().length} > ${VERDICT_ACCUMULATION_BUDGET})`,
  );
  assert(big.text().startsWith("xxxx"), "…and keeps the HEAD of the reply");
  // Past the budget appending stops, so a verdict that arrives afterwards is
  // still READ (the decision is made on the message in hand, never on the
  // truncated tail) even though it can no longer be APPENDED. That is the
  // documented head-keeping trade: the closing line the stop matched lives in
  // `status()`, and `parseVerdict` over the frozen reply is expected to fall
  // back to its default on a reply whose tail was cut. The budget is not a
  // filter on which verdicts are recognised.
  const budgeted = createVerdictStop();
  for (let i = 0; i < 200; i++) budgeted.observe(turn(text(chunk)));
  const before = budgeted.text().length;
  budgeted.observe(turn(text("VERDICT: CRITICAL_ISSUES_FOUND")));
  assert(
    budgeted.status() === "CRITICAL_ISSUES_FOUND",
    "the verdict after the budget still stops the child",
  );
  assert(
    budgeted.text().length === before,
    "…and nothing more is appended past the budget",
  );
  // The budget does not narrow what counts as a verdict: the very next reply,
  // from a stop with room, is recognised identically.
  const fresh = createVerdictStop();
  assert(
    fresh.observe(turn(text("VERDICT: CRITICAL_ISSUES_FOUND"))) === true,
    "the same verdict is recognised by a stop under the budget",
  );
  assert(fresh.text().length < VERDICT_ACCUMULATION_BUDGET, "…well inside the budget");
}


console.log(`\nexit ${exit}`);
process.exit(exit);
