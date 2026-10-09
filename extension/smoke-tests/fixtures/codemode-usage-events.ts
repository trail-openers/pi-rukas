#!/usr/bin/env bun
/**
 * #1032 — recorded event fixture proving collapseEvents' dispatch totals
 * equal assistant usage PLUS the toolResult message's own usage (the
 * SUMMED usage of the nested/codemode calls Pi stamps onto the parent
 * toolResult via `combineUsage`), counted exactly once each — not 2x
 * either figure on its own.
 *
 * The fixture mirrors the real shape: an `agent_end` whose `messages`
 * array holds (a) an assistant `message_end`-shaped message with its own
 * `usage` (the model call that issued the codemode script), and (b) a
 * `toolResult` message whose `usage` is the summed nested-call spend
 * (nested-tool-calls.d.ts `NestedCallSummary.usage`). The nested calls
 * themselves are NOT separate entries here — Pi never emits them as
 * assistant turns, which is precisely why counting only `role ===
 * "assistant"` (the old behaviour) silently dropped this spend.
 */

import type {
  PiJsonEvent,
  PiMessage,
} from "../../src/pi-event-shapes.ts";

/** The assistant message: the model call that ISSUED the codemode script. */
export const assistantMessage: PiMessage & { role: "assistant" } = {
  role: "assistant",
  model: "test-model",
  usage: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 5, cost: { total: 0.01 } },
  content: [{ type: "toolCall", id: "call_codemode_1", name: "codemode", arguments: { code: "" } }],
};

/**
 * The toolResult message: the parent call's result, carrying the SUMMED
 * usage of the nested calls the codemode script made. This `usage` field
 * is the only record of the nested spend — it is NOT double-counted from
 * anywhere else in the transcript.
 */
export const toolResultMessage: PiMessage & { role: "toolResult" } = {
  role: "toolResult",
  toolName: "codemode",
  toolCallId: "call_codemode_1",
  content: [{ type: "text", text: "nested calls complete" }],
  usage: { input: 500, output: 100, cacheRead: 25, cacheWrite: 2, cost: { total: 0.005 } },
};

/**
 * The full `agent_end` event as Pi would emit it: both messages, in order.
 * This is the single input collapseEvents is tested against for the
 * "no double count" acceptance criterion.
 */
export const codemodeUsageAgentEnd: PiJsonEvent = {
  type: "agent_end",
  messages: [assistantMessage, toolResultMessage],
};

/**
 * A toolResult message with NO usage — an empty or errored codemode call.
 * The summation must tolerate this shape (contribute 0, not throw, not
 * default to a bogus non-zero figure).
 */
export const toolResultNoUsage: PiMessage & { role: "toolResult" } = {
  role: "toolResult",
  toolName: "codemode",
  toolCallId: "call_codemode_1",
  content: [{ type: "text", text: "" }],
};

/** Expected totals: assistant + toolResult, summed field-by-field. */
export const EXPECTED_TOTALS = {
  input: 1000 + 500,
  output: 200 + 100,
  cacheRead: 50 + 25,
  cacheWrite: 5 + 2,
  cost: 0.01 + 0.005,
  // turn count is UNCHANGED by the toolResult — it is not an assistant turn.
  turns: 1,
};

/** Expected totals when the toolResult carries no usage (only assistant counts). */
export const EXPECTED_TOTALS_NO_USAGE = {
  input: 1000,
  output: 200,
  cacheRead: 50,
  cacheWrite: 5,
  cost: 0.01,
  turns: 1,
};
