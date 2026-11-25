#!/usr/bin/env bun
/**
 * Fixture for #2618: the shape Pi records for calls a tool made to OTHER tools.
 *
 * Pi stamps `nestedCalls` on the PARENT call's own `toolResult` message
 * (pi-ai's `ToolResultMessage`, filled from `NestedCallRecorder.snapshot()` in
 * `nested-tool-calls.js`): a bounded record of the calls, in the order the
 * calling tool made them, each with `{ id, name, arguments?, argumentsBytes?,
 * status, durationMs?, error? }`, and a `complete` flag that is false when calls
 * were dropped, arguments omitted, or a call had not finished. `arguments` is
 * omitted past 8 KiB per call / 32 KiB total and `argumentsBytes` carries their
 * size instead.
 *
 * The whole point of the fixture: these calls are NEVER assistant `toolCall`
 * blocks, so a reader that walks assistant content cannot see them — which is
 * the bug #2618 fixes. Hand-built here because no recorded transcript in this
 * suite carried the field.
 */

import type { PiJsonEvent, PiMessage } from "../../src/pi-event-shapes.ts";

/** One nested record, as Pi writes it. `Omit` so each case picks its own arm. */
export interface NestedRecordLike {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  argumentsBytes?: number;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  error?: string;
}

/** A nested record whose arguments Pi kept. */
export function nestedOk(
  id: string,
  name: string,
  args: Record<string, unknown>,
): NestedRecordLike {
  return { id, name, arguments: args, status: "ok", durationMs: 4 };
}

/** A nested record whose arguments Pi dropped (over its per-call size bound). */
export function nestedArgsOmitted(
  id: string,
  name: string,
  bytes = 12_000,
): NestedRecordLike {
  return { id, name, argumentsBytes: bytes, status: "ok" };
}

/** A nested record for a call that errored or never finished. */
export function nestedUnfinished(
  id: string,
  name: string,
  status: "error" | "unfinished",
  args: Record<string, unknown> = { criterionId: "AC1", testFiles: ["tests/AC1-never.test.sh"] },
): NestedRecordLike {
  return status === "error"
    ? { id, name, arguments: args, status, error: "schema rejected the call" }
    : { id, name, arguments: args, status };
}

/** The assistant turn that issued the codemode script. */
export function codemodeTurn(id: string, code = "tools.submit_tests({})"): PiMessage {
  return {
    role: "assistant",
    model: "test-model",
    provider: "test",
    stopReason: "toolUse",
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
    content: [{ type: "toolCall", id, name: "codemode", arguments: { code } }],
  } as PiMessage;
}

/** Any other assistant tool call (the direct half of a mixed case). */
export function directCallTurn(name: string, id: string, args: unknown): PiMessage {
  return {
    role: "assistant",
    model: "test-model",
    provider: "test",
    stopReason: "toolUse",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    content: [{ type: "toolCall", id, name, arguments: args }],
  } as PiMessage;
}

/** The parent tool result that carries the nested rows. */
export function codemodeResult(
  toolCallId: string,
  calls: NestedRecordLike[],
  complete = true,
): PiMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "codemode",
    isError: false,
    content: [{ type: "text", text: "Script completed" }],
    usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0005 } },
    nestedCalls: { calls, complete },
  } as PiMessage;
}

/** The result of a direct call (no nested rows of its own). */
export function directResult(toolCallId: string, toolName: string): PiMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    isError: false,
    content: [{ type: "text", text: "recorded" }],
  } as PiMessage;
}

/** An `agent_end` event carrying these messages — collapseEvents' input. */
export function agentEnd(messages: PiMessage[]): PiJsonEvent {
  return { type: "agent_end", messages } as PiJsonEvent;
}

/** One call per acceptance criterion, in the child's shape. */
export function submitArgs(criterionId: string, testFiles: string[]): Record<string, unknown> {
  return { criterionId, testFiles };
}

/** One blocked report, in the child's shape. */
export function blockedArgs(
  conflicts: Array<{ path: string; reason: string }>,
): Record<string, unknown> {
  return { conflicts };
}
