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
    assert(!added, "8a: tool_execution_end does not add an event to the buffer");
    assert(buf.length === 0, "8b: buffer remains empty after tool_execution_end");
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
    assert(!added, "9a: tool_execution_start without toolName is not stored");
    assert(buf.length === 0, "9b: buffer remains empty");
  } finally {
    dropBuffer(key);
  }
}

/** Fixture: a TOP-LEVEL tool_execution_start (Pi's agent-loop emits it
 * without parentToolCallId for every model-issued call). */
function topLevelStartEvent(toolCallId: string, toolName: string, args?: unknown): PiJsonEvent {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args: args ?? {},
  } as PiJsonEvent;
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
  assert(bufferCount() === before, "10a: buffer count returns to baseline after dropBuffer");
}

// ============================================================
// 11. Deck: NO double-count — a top-level tool call appears exactly once
//     (the assistant message's toolCall block); its flat
//     tool_execution_start (no parentToolCallId) adds NOTHING.
// ============================================================
{
  const key = "test-nested-deck-top-level";
  startBuffer(key);
  try {
    const buf: LiveEvent[] = [];
    // Pi's event order for a top-level call: the assistant message_end
    // (which carries the toolCall block) precedes the tool_execution_start.
    pushEvent(key, buf, assistantToolCallEnd("call_top", "codemode"));
    pushEvent(
      key,
      buf,
      topLevelStartEvent("call_top", "codemode", { script: "...", model: "..." }),
    );
    assert(
      buf.length === 1,
      `11a: the top-level call appears exactly once (got ${buf.length} — the flat event would have made two)`,
    );
    if (buf.length === 1) {
      assert(buf[0].kind === "toolCall", "11b: stored as a toolCall variant");
      if (buf[0].kind === "toolCall") {
        assert(
          buf[0].name === "codemode",
          `11c: it is the assistant-block entry, no ↳ prefix (got '${buf[0].name}')`,
        );
      }
    }
    // And a bare top-level start with no assistant block at all adds no
    // entry — top-level events are never the record; the block is.
    const buf2: LiveEvent[] = [];
    const added = pushEvent(key, buf2, topLevelStartEvent("call_other", "bash", { command: "ls" }));
    assert(!added, "11d: a lone top-level tool_execution_start adds no entry");
    assert(buf2.length === 0, "11e: buffer remains empty for a lone top-level start");
  } finally {
    dropBuffer(key);
  }
}

// ============================================================
// 12. InFlightTools: no double-count — a top-level call's flat
//     tool_execution_start must not open a SECOND span alongside the
//     assistant toolCall block's span.
// ============================================================
{
  const inflight = new InFlightTools();
  inflight.observe(assistantToolCallEnd("call_top", "codemode"));
  inflight.observe(topLevelStartEvent("call_top", "codemode", { script: "..." }));
  assert(
    inflight.toolNames().length === 1,
    `12a: the top-level call has exactly one span, not two (got ${inflight.toolNames().length})`,
  );
  assert(
    inflight.toolNames()[0] === "codemode",
    "12b: the span is the toolCall block's 'codemode' entry",
  );

  // A nested start with an UNKNOWN parent still opens its own span (the
  // flat event is the only record of a nested call — the parent span is a
  // different id).
  inflight.observe(nestedStartEvent("call_top/0", "bash", "call_top"));
  assert(
    inflight.toolNames().length === 2,
    `12c: the nested call opens its own distinct span (got ${inflight.toolNames().length})`,
  );
}

// ============================================================
// 13. InFlightTools: an orphaned nested span (no tool_execution_end —
//     the child died mid-tool) is closed by the PARENT's toolResult
// ============================================================
{
  const inflight = new InFlightTools();
  inflight.observe(assistantToolCallEnd("call_top", "codemode"));
  inflight.observe(nestedStartEvent("call_top/0", "bash", "call_top"));
  inflight.observe(nestedStartEvent("call_top/1", "read", "call_top"));
  assert(
    inflight.toolNames().length === 3,
    `13a: three spans open (top + 2 nested), got ${inflight.toolNames().length}`,
  );

  // One nested call finishes normally.
  inflight.observe(nestedEndEvent("call_top/0", "bash", "call_top"));
  assert(
    inflight.toolNames().length === 2,
    `13b: one nested closed, two remain (got ${inflight.toolNames().length})`,
  );

  // call_top/1 never gets its tool_execution_end (the stream was cut),
  // but the parent's toolResult arrives: the orphan must be closed with
  // the parent, or the tool-inactivity budget stays armed forever.
  inflight.observe(toolResultEvent("call_top", "codemode"));
  assert(
    !inflight.active,
    "13c: the parent's toolResult closes the orphaned nested span too",
  );
  assert(inflight.size === 0, "13d: the open set is empty");

  // A sibling's result must NOT close this parent's orphan (the prefix
  // match is exact, `P/` only). Two parents are open, each with an orphan;
  // `call_a`'s result arrives: only `call_a` and its orphan close.
  const inflight2 = new InFlightTools();
  inflight2.observe(assistantToolCallEnd("call_a", "codemode"));
  inflight2.observe(nestedStartEvent("call_a/0", "bash", "call_a"));
  inflight2.observe(assistantToolCallEnd("call_ab", "codemode"));
  inflight2.observe(nestedStartEvent("call_ab/0", "bash", "call_ab"));
  inflight2.observe(toolResultEvent("call_a", "codemode"));
  assert(inflight2.active, "13e: the sibling parent's spans survive call_a's result");
  assert(
    inflight2.toolNames().length === 2,
    `13f: call_ab and its orphan remain (got ${inflight2.toolNames().length})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
