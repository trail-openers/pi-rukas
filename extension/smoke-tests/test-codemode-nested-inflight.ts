#!/usr/bin/env bun
/**
 * #1032 — nested tool_execution_start events (codemode scripts via
 * ctx.executeTool) reach the in-flight tracker and the dispatch deck's
 * live buffer.
 *
 * Offline fixture test: no real child spawned. Exercises InFlightTools.observe
 * and dispatch-deck-live.pushEvent with the flat tool_execution_start /
 * tool_execution_end event shapes that Pi's RPC mode emits for nested calls.
 *
 * The invariant: a nested tool call opens a span on tool_execution_start
 * (keyed by its own toolCallId, which is "<callerId>/<n>") and closes it on
 * tool_execution_end. The in-flight tracker's `active` flag and `toolNames()`
 * must reflect the nested span. The deck's live buffer must store a toolCall
 * entry for the nested call (with a ↳ prefix on the name).
 */

import { InFlightTools } from "../src/spawn-inflight.ts";
import { pushEvent, startBuffer, getBuffer, bufferCount, dropBuffer } from "../src/dispatch-deck-live.ts";
import type { PiJsonEvent } from "../src/pi-event-shapes.ts";
import type { LiveEvent } from "../src/dispatch-deck-live.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Fixture: a tool_execution_start event for a nested bash call. */
function nestedStartEvent(
  toolCallId: string,
  toolName: string,
  parentToolCallId: string,
  args?: unknown,
): PiJsonEvent {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args: args ?? { command: "echo hello" },
    parentToolCallId,
  } as PiJsonEvent;
}

/** Fixture: a tool_execution_end event for the same nested call. */
function nestedEndEvent(
  toolCallId: string,
  toolName: string,
  parentToolCallId: string,
  isError = false,
): PiJsonEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result: "hello",
    isError,
    parentToolCallId,
  } as PiJsonEvent;
}

/** Fixture: a top-level toolCall block inside an assistant message_end. */
function assistantToolCallEnd(toolCallId: string, toolName: string): PiJsonEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
    },
  } as PiJsonEvent;
}

/** Fixture: a toolResult message closing a top-level span. */
function toolResultEvent(toolCallId: string, toolName: string): PiJsonEvent {
  return {
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: "done" }],
    },
  } as PiJsonEvent;
}

// ============================================================
// 1. InFlightTools: nested tool_execution_start opens a span
// ============================================================
{
  const inflight = new InFlightTools();
  assert(!inflight.active, "1a: no spans open initially");

  inflight.observe(assistantToolCallEnd("call_top", "codemode"));
  assert(inflight.active, "1b: top-level codemode toolCall opens a span");

  // A nested bash call inside the codemode script starts.
  inflight.observe(nestedStartEvent("call_top/0", "bash", "call_top"));
  assert(inflight.active, "1c: nested tool_execution_start keeps the set non-empty");
  assert(
    inflight.toolNames().length === 2,
    `1d: two spans open (top-level + nested), got ${inflight.toolNames().length}`,
  );
  assert(
    inflight.toolNames().includes("bash"),
    "1e: toolNames() includes the nested tool name 'bash'",
  );
}

// ============================================================
// 2. InFlightTools: nested tool_execution_end closes the nested span
// ============================================================
{
  const inflight = new InFlightTools();
  inflight.observe(assistantToolCallEnd("call_top", "codemode"));
  inflight.observe(nestedStartEvent("call_top/0", "bash", "call_top"));
  assert(inflight.toolNames().length === 2, "2a: two spans before nested end");

  inflight.observe(nestedEndEvent("call_top/0", "bash", "call_top"));
  assert(
    inflight.toolNames().length === 1,
    `2b: nested span closed, one span remains (got ${inflight.toolNames().length})`,
  );
  assert(
    inflight.toolNames()[0] === "codemode",
    "2c: the remaining span is the top-level codemode call",
  );

  // Now close the top-level with a toolResult.
  inflight.observe(toolResultEvent("call_top", "codemode"));
  assert(!inflight.active, "2d: all spans closed after toolResult");
}

// ============================================================
// 3. InFlightTools: multiple nested calls, each closed independently
// ============================================================
{
  const inflight = new InFlightTools();
  inflight.observe(assistantToolCallEnd("call_top", "codemode"));
  inflight.observe(nestedStartEvent("call_top/0", "bash", "call_top"));
  inflight.observe(nestedStartEvent("call_top/1", "read", "call_top"));
  assert(
    inflight.toolNames().length === 3,
    `3a: three spans open (top + 2 nested), got ${inflight.toolNames().length}`,
  );

  // Close only the first nested call.
  inflight.observe(nestedEndEvent("call_top/0", "bash", "call_top"));
  assert(
    inflight.toolNames().length === 2,
    `3b: one nested closed, two remain (got ${inflight.toolNames().length})`,
  );
  assert(
    !inflight.toolNames().includes("bash"),
    "3c: the closed nested 'bash' span is gone",
  );
  assert(inflight.toolNames().includes("read"), "3d: the open nested 'read' span remains");
}

// ============================================================
// 4. InFlightTools: tool_execution_start without toolCallId is a no-op
// ============================================================
{
  const inflight = new InFlightTools();
  inflight.observe({ type: "tool_execution_start", toolName: "bash" } as PiJsonEvent);
  assert(!inflight.active, "4a: tool_execution_start without toolCallId does not open a span");
}

// ============================================================
// 5. InFlightTools: tool_execution_end without toolCallId is a no-op
// ============================================================
{
  const inflight = new InFlightTools();
  inflight.observe(assistantToolCallEnd("call_1", "bash"));
  inflight.observe({ type: "tool_execution_end", toolName: "bash" } as PiJsonEvent);
  assert(inflight.active, "5a: tool_execution_end without toolCallId does not close the span");
}

// ============================================================
// 6. Deck: pushEvent surfaces tool_execution_start as a toolCall entry
// ============================================================
{
  const key = "test-nested-deck";
  startBuffer(key);
  try {
    const buf: LiveEvent[] = [];
    pushEvent(key, buf, nestedStartEvent("call_top/0", "bash", "call_top", { command: "ls -la" }));
    assert(buf.length === 1, `6a: one event stored for tool_execution_start (got ${buf.length})`);
    if (buf.length === 1) {
      assert(buf[0].kind === "toolCall", "6b: stored as a toolCall variant");
      if (buf[0].kind === "toolCall") {
        assert(
          buf[0].name === "↳ bash",
          `6c: name is '↳ bash' (got '${buf[0].name}')`,
        );
        assert(
          buf[0].args === JSON.stringify({ command: "ls -la" }),
          "6d: args is the JSON-stringified arguments",
        );
      }
    }
  } finally {
    dropBuffer(key);
  }
}

// ============================================================
// 7. Deck: nested args are sanitised at feed time (ESC stripped, newlines
//    collapsed) — the stored-string invariant (#927) holds for the nested
//    branch too
// ============================================================
{
  const key = "test-nested-deck-sanitise";
  startBuffer(key);
  try {
    const buf: LiveEvent[] = [];
    const esc = String.fromCharCode(27);
    const hostileArgs = {
      command: "echo hi\nworld\n\nmore", // raw newlines in the value
      note: esc + "[31mred text" + esc + "[0m", // raw ANSI CSI escapes
    };
    pushEvent(key, buf, nestedStartEvent("call_top/1", "bash", "call_top", hostileArgs));
    assert(buf.length === 1, `7c: one event stored for the hostile-args nested call (got ${buf.length})`);
    if (buf.length === 1 && buf[0].kind === "toolCall") {
      // JSON.stringify escapes control chars: \n → \\n, ESC → \\u001b.
      // sanitizeForStorage strips actual control chars (none remain) and
      // collapses actual newlines (none remain) — the JSON-escaped text
      // is printable and passes through unchanged. The key invariant:
      // no raw control character survives into the stored string.
      assert(
        !buf[0].args.includes("\n"),
        "7d: stored args contain no raw newline byte",
      );
      assert(
        !buf[0].args.includes(String.fromCharCode(27)),
        "7e: stored args contain no raw ESC byte",
      );
      // The payload content is preserved (sanitisation is idempotent on
      // already-escaped JSON).
      assert(
        buf[0].args.includes("red text"),
        "7f: the payload text survives sanitisation",
      );
      assert(
        buf[0].args.includes("echo hi"),
        "7g: the command text survives sanitisation",
      );
    } else {
      assert(false, "7h: the hostile-args nested call was stored as a toolCall");
    }
  } finally {
    dropBuffer(key);
  }
}

// ============================================================
// 8. Deck: tool_execution_end is NOT surfaced (the toolResult message
//    that follows already shows the result)
// ============================================================
{
  const key = "test-nested-deck-end";
  startBuffer(key);
  try {
    const buf: LiveEvent[] = [];
    const added = pushEvent(key, buf, nestedEndEvent("call_top/0", "bash", "call_top"));
    assert(!added, "7a: tool_execution_end does not add an event to the buffer");
    assert(buf.length === 0, "7b: buffer remains empty after tool_execution_end");
  } finally {
    dropBuffer(key);
  }
}

// ============================================================
// 9. Deck: tool_execution_start without toolName is not surfaced
// ============================================================
{
  const key = "test-nested-deck-noname";
  startBuffer(key);
  try {
    const buf: LiveEvent[] = [];
    const added = pushEvent(key, buf, { type: "tool_execution_start", toolCallId: "x/0" } as PiJsonEvent);
    assert(!added, "8a: tool_execution_start without toolName is not stored");
    assert(buf.length === 0, "8b: buffer remains empty");
  } finally {
    dropBuffer(key);
  }
}

// ============================================================
// 10. Deck: buffer lifecycle is clean (no leak)
// ============================================================
{
  const before = bufferCount();
  const key = `test-ns-leak-${Date.now()}`;
  startBuffer(key);
  const buf: LiveEvent[] = [];
  pushEvent(key, buf, nestedStartEvent("x/0", "bash", "x"));
  dropBuffer(key);
  assert(bufferCount() === before, "9a: buffer count returns to baseline after dropBuffer");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
