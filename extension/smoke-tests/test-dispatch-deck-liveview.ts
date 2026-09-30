#!/usr/bin/env bun
/**
 * #839 — live view of a running subagent's activity (dispatch deck, epic
 * #833 G5). Drives the real ring buffer and overlay with synthetic events:
 * ring eviction, feedRawEvent, overlay render/handleInput, dropBuffer,
 * clearEntry co-located lifecycle, quiet mode, and roster Enter →
 * live-view wiring.
 */

import { onRowConfirm } from "../src/dispatch-deck-confirm.ts";
import { bufferCount, dropBuffer, feedRawEvent, getBuffer, hasBuffer, startBuffer } from "../src/dispatch-deck-live.ts";
import { createAgentViewComponent, type ViewHeader } from "../src/dispatch-deck-live-view-component.ts";
import { clearEntry, detach, reset, snapshot, startEntry } from "../src/dispatch-deck.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function resetBuffers(): void {
  for (const k of ["b1", "b2", "b3"]) dropBuffer(k);
}

// ---------------------------------------------------------------------------
// 1. Buffer bound: the 200-event ring cap is gone; the bound is now chars
//    (LIVE_BUFFER_MAX_CHARS, oldest-first), exercised in the new buffer test
//    file. Tiny events no longer evict at all.
// ---------------------------------------------------------------------------
{
  resetBuffers();
  startBuffer("b1");
  for (let i = 0; i < 201; i++) {
    feedRawEvent("b1", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `msg-${i}` }] },
    });
  }
  const buf = getBuffer("b1");
  // before: 201 events → ring holds exactly LIVE_RING_CAP (200) / after: all 201
  // remain — the event-count cap was deleted in #916 (only the 512 KB byte
  // bound applies; see test-dispatch-deck-live-buffer.ts) (#916)
  assert(buf.length === 201, `1a: 201 tiny events all buffered (got ${buf.length})`);
  assert(buf[0]?.text === "msg-0", "1b: oldest (msg-0) retained — no event-count eviction");
  assert(buf[200]?.text === "msg-200", "1c: newest (msg-200) present");
  dropBuffer("b1");
}

// ---------------------------------------------------------------------------
// 2. Real observer path: synthetic message_end + toolResult events.
// ---------------------------------------------------------------------------
{
  resetBuffers();
  startBuffer("b2");
  // assistant message_end with text + toolCall
  feedRawEvent("b2", {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "investigating the failure" },
        { type: "toolCall", name: "bash", arguments: { command: "cargo test --lib" } },
      ],
    },
  });
  // toolResult message (separate role in Pi)
  feedRawEvent("b2", {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "test result: 12 passed, 0 failed" }],
    },
  });
  const buf = getBuffer("b2");
  assert(buf.length === 3, `2a: three events buffered (got ${buf.length})`);
  assert(
    buf[0]?.kind === "text" && buf[0].text === "investigating the failure",
    "2b: assistant text buffered",
  );
  assert(buf[1]?.kind === "toolCall" && buf[1].name === "bash", "2c: toolCall buffered with name");
  assert(
    buf[1]?.kind === "toolCall" && buf[1].args === JSON.stringify({ command: "cargo test --lib" }),
    "2d: object args stored as full JSON",
  );
  assert(
    buf[2]?.kind === "toolResult" && buf[2].text === "test result: 12 passed, 0 failed",
    "2e: toolResult buffered",
  );
  // toolResult with isError → marked
  feedRawEvent("b2", {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: "error: command failed" }],
    },
  });
  const buf2 = getBuffer("b2");
  assert(buf2[3]?.isError === true, "2f: error toolResult marked");
  dropBuffer("b2");
}

// ---------------------------------------------------------------------------
// 2b. Feed-time storage is UNTRUNCATED (#916): 500-char text/args/result
//     survive verbatim; only the per-job 512 KB byte bound applies.
// ---------------------------------------------------------------------------
{
  resetBuffers();
  startBuffer("b3");
  const long = "x".repeat(500);
  feedRawEvent("b3", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: long }] },
  });
  feedRawEvent("b3", {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: "y".repeat(300) } }],
    },
  });
  feedRawEvent("b3", {
    type: "message",
    message: {
      role: "toolResult",
      content: [{ type: "text", text: "z".repeat(300) }],
    },
  });
  const buf = getBuffer("b3");
  // before: text truncated to ≤400 at feed time / after: stored in full, no
  // truncation (#916)
  assert(buf[0]?.kind === "text" && buf[0].text === long, "2b-1: 500-char text stored verbatim");
  assert(!buf[0]?.text.endsWith("…"), "2b-2: no ellipsis — nothing truncated");
  // before: args truncated to ≤240 (50-char tool hint) / after: full JSON
  // stringify, untruncated (#916)
  assert(
    buf[1]?.kind === "toolCall" && buf[1].args === JSON.stringify({ command: "y".repeat(300) }),
    "2b-3: 300-char arg value stored as full JSON",
  );
  // before: result truncated to ≤200 / after: stored in full, untruncated
  // (#916)
  assert(
    buf[2]?.kind === "toolResult" && buf[2].text === "z".repeat(300),
    "2b-4: 300-char result stored verbatim",
  );
  dropBuffer("b3");
}

// ---------------------------------------------------------------------------
// 2c. Huge object arg: stored as FULL JSON — the 1 MB noise field is kept
//     in full (nothing is previewed or hinted any more).
// ---------------------------------------------------------------------------
{
  resetBuffers();
  startBuffer("b3");
  const huge = { noise: "w".repeat(1_000_000), command: "cargo test --lib" };
  feedRawEvent("b3", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: huge }] },
  });
  const arg = getBuffer("b3")[0] as { args: string };
  // before: huge object arg → 50-char command hint, noise dropped /
  // after: full JSON.stringify, noise field kept in full (#916)
  assert(arg.args === JSON.stringify(huge), "2c-a: huge object arg stored as full JSON");
  assert(arg.args.includes("w".repeat(100)), "2c-b: the noise field is stored in full");
  dropBuffer("b3");
}

// ---------------------------------------------------------------------------
// 3. Overlay renders events; new events appear on next render (same
//    component). before: drove the legacy createLiveViewComponent shim /
//    after: drives createAgentViewComponent directly (#916 slice B); the
//    old done('close') mapping is the new component's 'returnToList'.
// ---------------------------------------------------------------------------
const fakeTheme = { muted: (t: string) => t, error: (t: string) => t } as const;
function headerB1(): ViewHeader {
  return {
    label: "developer",
    role: "developer",
    status: "running",
    startedAt: Date.now(),
    now: Date.now(),
    turns: 1,
    totalTokens: 100,
    pmActive: false,
    notices: 0,
    settled: false,
  };
}
{
  resetBuffers();
  startBuffer("b1");
  const doneResults: string[] = [];
  const comp = createAgentViewComponent("b1", headerB1, fakeTheme, undefined, (r) =>
    doneResults.push(r),
  );
  // before: 3a pinned the shim's 'no activity yet' empty-buffer placeholder / after: removed — the full-screen component has no such placeholder (it renders the padded body + footer) (#916 slice B)
  feedRawEvent("b1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "starting work" }] },
  });
  const flat1 = comp.render(80).join("\n");
  assert(flat1.includes("starting work"), "3b: new event appears on the next render");
  assert(flat1.includes("developer"), "3c: header shows the role label");
  comp.handleInput("\x1b"); // Esc → close
  // before: 3d pinned done('close') — the shim remapped returnToList→close / after: the new component returns 'returnToList' verbatim (#916 slice B)
  assert(doneResults.includes("returnToList"), "3d: Esc → done('returnToList')");
  // #915: `s` now inserts into the input (no done('steer'))
  const comp2 = createAgentViewComponent("b1", headerB1, fakeTheme, undefined, (r) => {
    doneResults.push(`steer-${r}`);
  }, () => {});
  comp2.handleInput("s");
  assert((comp2 as unknown as { inputValue: () => string }).inputValue() === "s", "3e: 's' inserts into the input (no done)");
  dropBuffer("b1");
}

// ---------------------------------------------------------------------------
// 4. Scroll: ↑/↓ pause and resume following.
//    before: drove the shim's EVENT-offset scroll (↑ paused at ANY buffer
//    length; ↓/End resumed) / after: the full-screen component's LINE-offset
//    scroll — ↑ pauses (footer 'paused') and End resumes at the same width
//    and buffer (#916 slice B).
// ---------------------------------------------------------------------------
{
  resetBuffers();
  startBuffer("b2");
  // 30 events: taller than the view's body window (24 lines), so ↑ actually
  // scrolls back (the shim's event-offset scroll did not need that).
  for (let i = 0; i < 30; i++) {
    feedRawEvent("b2", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `line-${i}` }] },
    });
  }
  const comp = createAgentViewComponent("b2", headerB1, fakeTheme, undefined, () => {});
  // Initially following (offset 0): render shows the last 10 events.
  let flat = comp.render(80).join("\n");
  assert(flat.includes("line-29"), "4a: following shows the newest event");
  // ↑ → pause: the footer shows 'paused'.
  comp.handleInput("\x1b[A");
  flat = comp.render(80).join("\n");
  assert(flat.includes("paused"), "4b: ↑ pauses following (footer shows 'paused')");
  // End → resume following (offset 0).
  comp.handleInput("\x1b[F");
  flat = comp.render(80).join("\n");
  assert(flat.includes("line-29"), "4c: End resumes following");
  // before: 4d pinned the shim's ↓-resume (legacy event-offset semantics) /
  // after: removed — the new component's ↓ moves DOWN toward the tail and
  // only End/G re-enters follow mode (#916 slice B)
  dropBuffer("b2");
}

// ---------------------------------------------------------------------------
// 5. Buffer freed on dropBuffer (clear).
// ---------------------------------------------------------------------------
{
  resetBuffers();
  startBuffer("b1");
  feedRawEvent("b1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x" }] },
  });
  assert(hasBuffer("b1"), "5a: buffer exists before drop");
  dropBuffer("b1");
  assert(!hasBuffer("b1"), "5b: buffer gone after drop");
  assert(bufferCount() === 0, "5c: buffer count is 0 after drop");
}

// ---------------------------------------------------------------------------
// 7. Roster Enter → live view (running row WITH buffer → custom overlay;
//    no picker). Row WITHOUT buffer → steer prompt directly (no custom).
// ---------------------------------------------------------------------------
{
  resetBuffers();
  reset();
  // --- 7a: running row with buffer → custom(overlay:true) called, no steer prompt
  startBuffer("deck-job-1");
  startEntry("deck-job-1", { label: "developer", role: "developer" });
  const customCalls: Array<unknown> = [];
  const editorCalls: string[] = [];
  const ctx = fakeCtx({ custom: customCalls, editors: editorCalls });
  await onRowConfirm(ctx, "deck-job-1", rowHost());
  assert(customCalls.length === 1, "7a: running row with buffer → custom called once");
  assert(
    (customCalls[0] as { overlay?: boolean })?.overlay === true,
    "7b: custom called with overlay:true",
  );
  assert(editorCalls.length === 0, "7c: no steer prompt (no editor call)");
  clearEntry("deck-job-1");
  dropBuffer("deck-job-1");

  startEntry("deck-job-2", { label: "explore", role: "explore" }); // 7b: no buffer → steer directly
  const customCalls2: unknown[] = [];
  const editorCalls2: string[] = [];
  const fakeCtx2 = fakeCtx({ custom: customCalls2, editors: editorCalls2 });
  await onRowConfirm(fakeCtx2, "deck-job-2", rowHost());
  assert(customCalls2.length === 0, "7d: running row without buffer → no custom call");
  assert(editorCalls2.length === 1, "7e: steer prompt opened directly (editor called)");
  clearEntry("deck-job-2");
  detach();

  startEntry("deck-job-4", { label: "explore", role: "explore" }); // 7f: rejecting editor is caught
  const fakeCtx4 = fakeCtx({ custom: [], editors: [], rejectEditor: true });
  let threw = false;
  try {
    await onRowConfirm(fakeCtx4, "deck-job-4", rowHost());
  } catch {
    threw = true;
  }
  assert(!threw, "7f: rejecting editor → caught, onRowConfirm resolves (no throw escapes)");
  clearEntry("deck-job-4");
  detach();
}

// ---------------------------------------------------------------------------
// 8. Entry is running (not settled) — the deck shows only RUNNING rows.
// ---------------------------------------------------------------------------
{
  resetBuffers();
  reset();
  startEntry("deck-job-3", { label: "developer", role: "developer" });
  const snap = snapshot();
  const entry = snap.find((e) => e.key === "deck-job-3");
  assert(!!entry, "8a: entry exists");
  assert(entry?.state.done === false, "8b: entry is running (not settled)");
  clearEntry("deck-job-3");
  detach();
}

function rowHost() {
  return { getEntry: (k: string) => snapshot().find((e) => e.key === k), steer: () => {} };
}
// #915: buildSteerPrompt is no longer needed in the LiveViewHost — only
// getEntry remains.

// Fake ExtensionContext for onRowConfirm; `custom`/`editor` are recorded so
// the assertions can inspect what the roster action opened.
function fakeCtx(rec: {
  custom: Array<unknown>;
  editors: string[];
  rejectEditor?: boolean;
}) {
  return {
    hasUI: true,
    ui: {
      custom: (_f: unknown, o?: unknown) => {
        // Record the options (ctx.ui.custom's second argument) so the
        // assertions can see the `overlay: true` flag the production caller
        // (openLiveView) passes; the first argument is the component factory.
        rec.custom.push(o);
        return Promise.resolve("close");
      },
      // #915: the steer prompt is no longer opened from the live view
      editor: (t: string, _p: string) => {
        if (rec.rejectEditor) return Promise.reject(new Error("editor unsupported"));
        rec.editors.push(t);
        return Promise.resolve("hello");
      },
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof onRowConfirm>[0];
}
// ---------------------------------------------------------------------------
// 9. Exception safety: feedRawEvent never throws on bounded inputs.
// ---------------------------------------------------------------------------
{
  resetBuffers();
  startBuffer("b9");
  let threw = false;
  try {
    // A malformed / huge event must not throw from pushEvent.
    feedRawEvent("b9", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(10_000) }] },
    });
  } catch {
    threw = true;
  }
  assert(!threw, "9a: feedRawEvent does not throw on large input");
  assert(getBuffer("b9")?.length === 1, "9b: one event buffered");
  // before: truncation bounds the ring entry to ≤400 / after: the 10 000-char
  // text is stored in full — no feed-time truncation any more (#916)
  assert(
    (getBuffer("b9")[0] as { text: string }).text.length === 10_000,
    "9c: 10 000-char event stored untruncated",
  );
  // Unknown event type is a no-op, never a throw.
  let threwUnknown = false;
  try {
    feedRawEvent("b9", { type: "unknown_event", nonsense: true } as never);
  } catch {
    threwUnknown = true;
  }
  assert(!threwUnknown, "9d: unknown event type does not throw");
  assert(getBuffer("b9")?.length === 1, "9e: unknown event not buffered");
  dropBuffer("b9");
  // Feed after drop is a no-op, never a throw.
  let threwAfterDrop = false;
  try {
    feedRawEvent("b9", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "y" }] },
    });
  } catch {
    threwAfterDrop = true;
  }
  assert(!threwAfterDrop, "9f: feed after drop is a no-op, never throws");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
