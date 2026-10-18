#!/usr/bin/env bun
/**
 * #1465 part a — the in-flight span leak.
 *
 * A developer was killed as `tool-inactivity` with "toolCall in flight: bash,
 * bash, bash, bash, read, read, bash, …" — far more calls than a child can
 * have open at once. The span set grew by every call of every turn, so the
 * 60-min tool bound was armed when the 30-min model-silence one should have
 * been, and the kill named a cause that was not true.
 *
 * Root cause: `InFlightTools.observe` opened a span on ANY event carrying an
 * assistant message with toolCall blocks. Pi's agent loop emits `turn_end`
 * with `message` = the turn's assistant message AFTER its tool results, so
 * every completed call was re-opened at turn end and never closed again. A
 * second path: an assistant message that ended `error` / `aborted` carries
 * its partial toolCall blocks, but Pi executes none of them (agent-loop
 * returns before the tool batch), so no result ever closes those spans.
 *
 * The event sequences below follow Pi's agent-loop emission order.
 */

import type { PiJsonEvent } from "../src/pi-event-shapes.ts";
import { InFlightTools } from "../src/spawn-inflight.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function assistant(id: string, name: string, stopReason = "toolUse") {
  return {
    role: "assistant" as const,
    stopReason,
    content: [{ type: "toolCall", id, name, arguments: { command: "x" } }],
  };
}

/** One full Pi turn with one tool call, in agent-loop order. */
function turn(id: string, name: string): PiJsonEvent[] {
  const msg = assistant(id, name);
  const result = { role: "toolResult" as const, toolCallId: id, toolName: name, isError: false };
  return [
    { type: "turn_start" },
    { type: "message_start", message: { ...msg, content: [] } },
    { type: "message_update", message: msg },
    { type: "message_end", message: msg },
    { type: "tool_execution_start", toolCallId: id, toolName: name, args: {} },
    { type: "tool_execution_update", toolCallId: id, toolName: name, args: {} },
    { type: "tool_execution_end", toolCallId: id, toolName: name, result: "ok", isError: false },
    { type: "message_start", message: result },
    { type: "message_end", message: result },
    { type: "turn_end", message: msg, toolResults: [result] },
  ] as PiJsonEvent[];
}

// 1 — completed turns leave nothing in flight.
{
  const t = new InFlightTools();
  for (let i = 0; i < 13; i++)
    for (const e of turn(`call_${i}`, i % 3 ? "bash" : "read")) t.observe(e);
  assert(
    t.size === 0,
    `13 completed turns leave 0 spans open (got ${t.size}: ${t.toolNames().join(", ")})`,
  );
  assert(
    !t.active,
    "no tool is in flight after every call returned, so the model-silence bound is the armed one",
  );
}

// 2 — a call still running is in flight, and only that call.
{
  const t = new InFlightTools();
  for (const e of turn("call_a", "bash")) t.observe(e);
  const live = turn("call_b", "bash").slice(0, 6); // through tool_execution_update
  for (const e of live) t.observe(e);
  assert(t.size === 1, `one live call after a completed turn is exactly one span (got ${t.size})`);
  assert(t.toolNames().join() === "bash", "the live span names the running tool");
}

// 3 — an aborted / errored assistant message runs none of its toolCalls.
for (const stopReason of ["aborted", "error"]) {
  const t = new InFlightTools();
  const msg = assistant("call_x", "bash", stopReason);
  for (const e of [
    { type: "message_update", message: msg },
    { type: "message_end", message: msg },
    { type: "turn_end", message: msg, toolResults: [] },
  ] as PiJsonEvent[])
    t.observe(e);
  assert(t.size === 0, `a ${stopReason} assistant message opens no span (got ${t.size})`);
}

// 4 — the toolCall block and tool_execution_start of one call are one span.
{
  const t = new InFlightTools();
  const events = turn("call_1", "bash");
  for (const e of events.slice(0, 5)) t.observe(e); // through tool_execution_start
  assert(
    t.size === 1,
    `toolCall block + tool_execution_start of the same call are one span (got ${t.size})`,
  );
}

process.exit(exit);
