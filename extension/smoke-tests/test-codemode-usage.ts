#!/usr/bin/env bun
/**
 * #1032 — offline fixture test for the codemode toolResult-usage counting
 * change.
 *
 * Acceptance criterion (issue #1032):
 *   "A recorded event fixture (committed under extension/smoke-tests/fixtures/)
 *    proves collapseEvents' dispatch totals equal assistant usage plus
 *    codemode toolResult usage, with no double count — the fixture must
 *    contain both an assistant message with usage and a toolResult message
 *    with usage, and the test asserts the summed total equals the sum of
 *    both, not 2x either."
 *
 * Also covers the zero-usage toolResult shape (empty/errored codemode call)
 * and confirms `turns` is not inflated by the toolResult.
 *
 * No Pi spawns — pure fixture-driven unit test.
 */

import { collapseEvents } from "../src/spawn-collapse-events.ts";
import {
  emptyRunningState,
  ingestEvent,
} from "../src/progress.ts";
import {
  codemodeUsageAgentEnd,
  toolResultNoUsage,
  assistantMessage,
  toolResultMessage,
  EXPECTED_TOTALS,
  EXPECTED_TOTALS_NO_USAGE,
} from "./fixtures/codemode-usage-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// --- collapseEvents: assistant + toolResult usage, no double count ----------

{
  const result = collapseEvents(codemodeUsageAgentEnd, null, "developer", 0, 0, "");
  const u = result.usage;

  assert(approx(u.input, EXPECTED_TOTALS.input), `collapseEvents input = ${u.input} (expected ${EXPECTED_TOTALS.input})`);
  assert(approx(u.output, EXPECTED_TOTALS.output), `collapseEvents output = ${u.output} (expected ${EXPECTED_TOTALS.output})`);
  assert(approx(u.cacheRead, EXPECTED_TOTALS.cacheRead), `collapseEvents cacheRead = ${u.cacheRead} (expected ${EXPECTED_TOTALS.cacheRead})`);
  assert(approx(u.cacheWrite, EXPECTED_TOTALS.cacheWrite), `collapseEvents cacheWrite = ${u.cacheWrite} (expected ${EXPECTED_TOTALS.cacheWrite})`);
  assert(approx(u.cost, EXPECTED_TOTALS.cost), `collapseEvents cost = ${u.cost} (expected ${EXPECTED_TOTALS.cost})`);
  assert(u.turns === EXPECTED_TOTALS.turns, `collapseEvents turns = ${u.turns} (expected ${EXPECTED_TOTALS.turns} — toolResult must not inflate turn count)`);

  // Not 2x either figure alone:
  assert(u.input !== 2000, "total input is NOT 2x assistant (2000)");
  assert(u.input !== 1000, "total input is NOT assistant-only (1000)");
  assert(u.input !== 500, "total input is NOT toolResult-only (500)");
}

// --- collapseEvents: toolResult with NO usage (empty/errored codemode call) --

{
  const result = collapseEvents(toolResultNoUsage, null, "developer", 0, 0, "");
  const u = result.usage;

  assert(approx(u.input, EXPECTED_TOTALS_NO_USAGE.input), "no-usage toolResult: input = assistant only");
  assert(approx(u.output, EXPECTED_TOTALS_NO_USAGE.output), "no-usage toolResult: output = assistant only");
  assert(approx(u.cost, EXPECTED_TOTALS_NO_USAGE.cost), "no-usage toolResult: cost = assistant only");
  assert(u.turns === EXPECTED_TOTALS_NO_USAGE.turns, "no-usage toolResult: turns still 1");
}

// --- progress.ts ingestEvent: live path must match collapseEvents ------------

{
  const state = emptyRunningState("developer");
  const start = Date.now();

  ingestEvent(
    state,
    { type: "message_end", message: assistantMessage },
    start,
  );
  ingestEvent(
    state,
    { type: "message_end", message: toolResultMessage },
    start,
  );

  const u = state.usage;
  assert(approx(u.input, EXPECTED_TOTALS.input), `ingestEvent input = ${u.input} (expected ${EXPECTED_TOTALS.input})`);
  assert(approx(u.output, EXPECTED_TOTALS.output), `ingestEvent output = ${u.output} (expected ${EXPECTED_TOTALS.output})`);
  assert(approx(u.cacheRead, EXPECTED_TOTALS.cacheRead), `ingestEvent cacheRead = ${u.cacheRead} (expected ${EXPECTED_TOTALS.cacheRead})`);
  assert(approx(u.cacheWrite, EXPECTED_TOTALS.cacheWrite), `ingestEvent cacheWrite = ${u.cacheWrite} (expected ${EXPECTED_TOTALS.cacheWrite})`);
  assert(approx(u.cost, EXPECTED_TOTALS.cost), `ingestEvent cost = ${u.cost} (expected ${EXPECTED_TOTALS.cost})`);
  assert(state.turns === EXPECTED_TOTALS.turns, `ingestEvent turns = ${state.turns} (expected ${EXPECTED_TOTALS.turns} — toolResult must not advance turn count)`);

  const expectedTotalTokens =
    EXPECTED_TOTALS.input + EXPECTED_TOTALS.output + EXPECTED_TOTALS.cacheRead + EXPECTED_TOTALS.cacheWrite;
  assert(
    approx(state.totalTokens, expectedTotalTokens),
    `ingestEvent totalTokens = ${state.totalTokens} (expected ${expectedTotalTokens})`,
  );
}

// --- progress.ts ingestEvent: toolResult with no usage contributes 0 ----------

{
  const state = emptyRunningState("developer");
  const start = Date.now();

  ingestEvent(
    state,
    { type: "message_end", message: assistantMessage },
    start,
  );
  ingestEvent(
    state,
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "codemode",
        toolCallId: "call_codemode_1",
        content: [{ type: "text", text: "" }],
      },
    },
    start,
  );

  const u = state.usage;
  assert(approx(u.input, EXPECTED_TOTALS_NO_USAGE.input), "no-usage toolResult (ingestEvent): input = assistant only");
  assert(approx(u.cost, EXPECTED_TOTALS_NO_USAGE.cost), "no-usage toolResult (ingestEvent): cost = assistant only");
  assert(state.turns === EXPECTED_TOTALS_NO_USAGE.turns, "no-usage toolResult (ingestEvent): turns still 1");
}

process.exit(exit);
