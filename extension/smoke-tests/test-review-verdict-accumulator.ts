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
    exited: () => false,
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
  const CRIT = "VERDICT: CRITICAL_ISSUES_FOUND";
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
  // 31 × 8 KB: the head is truncated and room remains — 2 characters for the
  // block's join plus the whole closing block. That is the ordinary shape of a
  // long review, and the case the round-4 rule got wrong in the common instance
  // (it appended nothing once the head looked full).
  for (let i = 0; i < 31; i++) budgeted.observe(turn(text(chunk)));
  const before = budgeted.text().length;
  budgeted.observe(turn(text("VERDICT: CRITICAL_ISSUES_FOUND")));
  assert(
    budgeted.status() === "CRITICAL_ISSUES_FOUND",
    "the verdict after the budget still stops the child",
  );
  // #1827 round 5 — the matched block is KEPT: its join and its whole text, so
  // `parseVerdict(result.text)` reads the verdict that ended the child. Under the
  // round-4 rule this growth was 0 and the reply lost the marker.
  assert(
    budgeted.text().endsWith(`\n${CRIT}`) && budgeted.text().length === before + 1 + CRIT.length,
    `…and the matched closing block is kept past the budget (+${budgeted.text().length - before})`,
  );
  budgeted.observe(turn(text("more prose after the stop")));
  assert(
    budgeted.text().length === before + 1 + CRIT.length &&
      budgeted.text().endsWith(`\n${CRIT}`),
    `…as the only block ever appended past it (+${budgeted.text().length - before})`,
  );
  // The cap is total for ordinary prose; the single matched block is the only
  // thing that can pass it, so the memory ceiling is the budget plus one closing
  // block. Here the block fitted, so the freeze sits under the budget.
  const overshoot = baseResult({ text: "(no output)" });
  applyReviewBounds(
    { stoppedByVerdict: true, verdictText: budgeted.text(), verdictStatus: budgeted.status() },
    overshoot,
    () => undefined,
    () => undefined,
  );
  assert(
    overshoot.text.length <= VERDICT_ACCUMULATION_BUDGET,
    `a close that fits never passes the cap (${overshoot.text.length - VERDICT_ACCUMULATION_BUDGET})`,
  );
  assert(
    parseVerdict(overshoot.text).status === "CRITICAL_ISSUES_FOUND",
    "…and the frozen reply parses to the verdict that ended the child",
  );
  // The overshoot case: the head has filled the budget to the character, so no
  // room remains — and the matched block STILL goes in, whole, because a
  // `VERDICT:` line truncated to a prefix matches no reader. This is the shape
  // the round-4 rule silently destroyed.
  const starved = createVerdictStop();
  for (let i = 0; i < 32; i++) starved.observe(turn(text(chunk)));
  assert(
    starved.text().length === VERDICT_ACCUMULATION_BUDGET - 31,
    `the head fills the budget (${starved.text().length})`,
  );
  starved.observe(turn(text(CRIT)));
  assert(starved.status() === "CRITICAL_ISSUES_FOUND", "a verdict with no room left still stops");
  // One `\n` from the join, then the block whole: `\n` + 31 chars where the
  // ordinary rule's room was already spent.
  assert(
    starved.text().endsWith(`\n${CRIT}`) &&
      starved.text().length === VERDICT_ACCUMULATION_BUDGET - 31 + 1 + CRIT.length,
    `…and is appended whole past the cap, not dropped and not truncated (+${starved.text().length - (VERDICT_ACCUMULATION_BUDGET - 31)})`,
  );
  assert(
    parseVerdict(starved.text()).status === "CRITICAL_ISSUES_FOUND",
    "…so the frozen reply and the stop agree",
  );
  // The head-keeping trade when the close is itself enormous: the head is capped
  // and the matched block is kept WHOLE — never silently truncated to a prefix no
  // reader can match, which is the failure the round-4 budget actually shipped.
  const hugeClose = createVerdictStop();
  for (let i = 0; i < 200; i++) hugeClose.observe(turn(text(chunk)));
  const close = `${"z".repeat(40 * 1024)}\n\nVERDICT: APPROVED`;
  hugeClose.observe(turn(text(close)));
  assert(hugeClose.status() === "APPROVED", "an oversized closing block still stops the child");
  assert(
    hugeClose.text().endsWith(close),
    "…and is kept whole, not truncated to an unreadable prefix",
  );
  assert(
    parseVerdict(hugeClose.text()).status === "APPROVED",
    "…so the frozen reply and the stop agree even there",
  );
  assert(
    hugeClose.text().length <= VERDICT_ACCUMULATION_BUDGET + close.length + 2,
    `…with the cap exceeded by that block alone (${hugeClose.text().length})`,
  );
  // The budget is not a filter on which verdicts are RECOGNISED: the very next
  // reply, from a stop with room, is recognised identically.
  const fresh = createVerdictStop();
  assert(
    fresh.observe(turn(text("VERDICT: CRITICAL_ISSUES_FOUND"))) === true,
    "the same verdict is recognised by a stop under the budget",
  );
  assert(fresh.text().length < VERDICT_ACCUMULATION_BUDGET, "…well inside the budget");
}


// (12) #1827 round 5 — the reported defect: past the budget the frozen reply
// kept the HEAD but lost the verdict, so `parseVerdict(result.text)` disagreed
// with the stop that ended the child and a CLEAN review read as `incomplete`
// (the loop's no-marker default is ISSUES_FOUND with verdictParsed false).
// Eighty turns of 5 KB fill the 256 KB cap, and the reply then closes tool-free
// on the verdict line — the ordinary shape of a long review, where the head is
// truncated and the close must still survive.
{
  const longTurn = "y".repeat(5 * 1024);
  for (const verdict of ["APPROVED", "MINOR_OBSERVATIONS"] as const) {
    const stop = createVerdictStop();
    for (let i = 0; i < 80; i++) stop.observe(turn(text(longTurn)));
    assert(stop.status() === undefined, `an unfinished ${verdict} reply has no verdict yet`);
  // 80 × 5 KB = 400 KB: past the cap, so the head IS truncated, and the joined
  // text sits two characters under it (one join reserved for a block that was
  // refused) — leaving room for the closing line, which is exactly the case the
  // round-4 budget got wrong: it refused that block as "at the cap" and the
  // frozen reply lost the verdict. A reply so long that not even the matched
  // block fits stays the head-keeping trade pinned in (11).
    assert(
      stop.text().length >= VERDICT_ACCUMULATION_BUDGET - longTurn.length &&
        stop.text().length <= VERDICT_ACCUMULATION_BUDGET,
      `the accumulation has filled the cap and still has room for the close (${stop.text().length} of ${VERDICT_ACCUMULATION_BUDGET})`,
    );
    const calls: string[] = [];
    // A tool call makes the turn incomplete however clean its text reads, and
    // the accumulator appends a block that goes on to be refused — so this is
    // also the shape where the forced append costs budget on text that stopped
    // nothing. It is one block, and it never makes a refusal STOP.
    observeReviewBounds(
      {
        verdictStop: stop,
        assistantMessageEnd: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              text("Still working."),
              { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
              text(`Maybe:\n\nVERDICT: ${verdict}`),
            ],
          },
        },
      } as unknown as { verdictStop: typeof stop; assistantMessageEnd: PiJsonEvent },
      quietTargets(calls),
    );
    assert(
      calls.length === 0 && stop.status() === undefined,
      `a verdict alongside a tool call still stops nothing (${calls.join(",")})`,
    );
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
      r.text.length <= VERDICT_ACCUMULATION_BUDGET,
      `the freeze never exceeds the budget when there was room (${r.text.length})`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
