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
import { createVerdictStop, observeReviewBounds, type ReviewBoundTargets } from "../src/review-bounds.ts";
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
function quietTargets(calls: string[]): ReviewBoundTargets {
  return {
    writeSteer: () => undefined,
    kill: () => calls.push("kill"),
    completePrompt: () => calls.push("completePrompt"),
    armBound: () => calls.push("armBound"),
    setKillCause: (c) => calls.push(`cause:${String(c)}`),
    reported: () => false,
    boundArmed: () => false,
    willRetry: () => false,
  };
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
  // Past the budget appending stops for ORDINARY prose, so a verdict that
  // arrives afterwards is still READ (the decision is made on the message in
  // hand, never on the truncated tail). The one block that does get appended is
  // the matched closing block itself — see (12) below, which is what keeps
  // `parseVerdict` over the frozen reply in agreement with the stop.
  const budgeted = createVerdictStop();
  for (let i = 0; i < 200; i++) budgeted.observe(turn(text(chunk)));
  const before = budgeted.text().length;
  budgeted.observe(turn(text("VERDICT: CRITICAL_ISSUES_FOUND")));
  assert(
    budgeted.status() === "CRITICAL_ISSUES_FOUND",
    "the verdict after the budget still stops the child",
  );
  // #1827 round 5 — and it is APPENDED, because the fold makes this accumulation
  // `result.text` and `parseVerdict(result.text)` has to read the same verdict
  // that ended the child. The old assertion pinned the opposite (no growth past
  // the budget), which was the reported defect.
  assert(
    budgeted.text().length > before && budgeted.text().endsWith("VERDICT: CRITICAL_ISSUES_FOUND"),
    "…and the matched closing block is kept past the budget",
  );
  // A stop that never fires keeps the budget absolutely: the accumulation is
  // only ever one matched block over the cap, and only when a stop fired.
  const quiet = createVerdictStop();
  for (let i = 0; i < 400; i++) quiet.observe(turn(text(chunk)));
  assert(
    quiet.text().length <= VERDICT_ACCUMULATION_BUDGET && quiet.status() === undefined,
    `an unfired stop stays inside the budget (${quiet.text().length})`,
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


// ── (12) #1827 round 5 — the reported defect: past the budget the frozen reply
// kept the HEAD but lost the verdict, so `parseVerdict(result.text)` disagreed
// with the stop that ended the child and a CLEAN review read as `incomplete`
// (the loop's no-marker default is ISSUES_FOUND with verdictParsed false).
// Eighty turns of 5 KB each is 400 KB, well past the 256 KB budget, and the
// reply then closes tool-free on the verdict line.
{
  const longTurn = "y".repeat(5 * 1024);
  for (const verdict of ["APPROVED", "MINOR_OBSERVATIONS"] as const) {
    const stop = createVerdictStop();
    for (let i = 0; i < 80; i++) stop.observe(turn(text(longTurn)));
    assert(stop.status() === undefined, `an unfinished ${verdict} reply has no verdict yet`);
    assert(
      stop.text().length > VERDICT_ACCUMULATION_BUDGET * 0.9,
      `…and the accumulation is past the budget before the verdict (${stop.text().length})`,
    );
    const calls: string[] = [];
    observeReviewBounds(
      {
        verdictStop: stop,
        assistantMessageEnd: turn(text(`All gates green.\n\nVERDICT: ${verdict}`)),
      },
      quietTargets(calls),
    );
    assert(stop.status() === verdict, `the ${verdict} verdict ends the child`);
    assert(stop.stopped() === true, "…and records the clean end");
    const r = baseResult({ text: "(thinking content only - no text output)" });
    applyReviewBounds(
      { stoppedByVerdict: true, verdictText: stop.text(), verdictStatus: stop.status() },
      r,
      () => undefined,
      () => undefined,
    );
    const parsed = parseVerdict(r.text);
    assert(
      parsed.verdictParsed === true,
      `parseVerdict reads a verdict out of the frozen reply past the budget (${verdict})`,
    );
    assert(
      parsed.status === stop.status(),
      `…and it is the status that ended the child (${parsed.status} vs ${String(stop.status())})`,
    );
    assert(
      r.text.length <= VERDICT_ACCUMULATION_BUDGET + longTurn.length + 40,
      `the freeze is at most the matched block over the budget (${r.text.length})`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
