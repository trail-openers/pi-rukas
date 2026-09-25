#!/usr/bin/env bun
/**
 * #839 — live view of a running subagent's activity (dispatch deck, epic
 * #833 G5). Drives the real ring buffer and overlay with synthetic events:
 * ring eviction, feedRawEvent, overlay render/handleInput, dropBuffer,
 * clearEntry co-located lifecycle, quiet mode, sync-throw exception safety
 * (startJob + startBatch), and roster Enter → live-view wiring.
 */

import { startBatch, startJob } from "../src/async-jobs.ts";
import { onRowConfirm } from "../src/dispatch-deck-confirm.ts";
import {
  LIVE_RING_CAP,
  bufferCount,
  createLiveViewComponent,
  dropBuffer,
  feedRawEvent,
  getBuffer,
  hasBuffer,
  startBuffer,
} from "../src/dispatch-deck-live.ts";
import { batchSnapshot, clearEntry, detach, reset, snapshot, startEntry } from "../src/dispatch-deck.ts";

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
// 1. Ring eviction: 201 events → exactly the newest 200 remain.
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
  assert(
    buf.length === LIVE_RING_CAP,
    `1a: 201 events → ring holds exactly ${LIVE_RING_CAP} (got ${buf.length})`,
  );
  assert(buf[0]?.text === "msg-1", "1b: oldest (msg-0) evicted");
  assert(buf[199]?.text === "msg-200", "1c: newest (msg-200) present");
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
  assert(buf[1]?.args.includes("cargo test --lib"), "2d: tool args stringified + trimmed");
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
// 2b. Truncation at feed time: 400 text, 240 args, 200 result.
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
  assert(buf[0]?.kind === "text" && buf[0].text.length <= 400, "2b-1: text truncated to ≤400");
  assert(buf[0].text.endsWith("…"), "2b-2: text has ellipsis");
  assert(buf[1]?.kind === "toolCall" && buf[1].args.length <= 240, "2b-3: args truncated to ≤240");
  assert(
    buf[2]?.kind === "toolResult" && buf[2].text.length <= 200,
    "2b-4: result truncated to ≤200",
  );
  dropBuffer("b3");
}

// ---------------------------------------------------------------------------
// 3. Overlay renders events; new events appear on next render (same component).
// ---------------------------------------------------------------------------
const fakeTheme = { muted: (t: string) => t, error: (t: string) => t } as const;
{
  resetBuffers();
  startBuffer("b1");
  const doneResults: string[] = [];
  const comp = createLiveViewComponent(
    "b1",
    () => ({
      label: "developer",
      role: "developer",
      startedAt: Date.now(),
      now: Date.now(),
      turns: 1,
      toolUses: 1,
      totalTokens: 100,
      lastToolName: "bash",
    }),
    fakeTheme,
    (r) => doneResults.push(r),
  );
  // render before any events → "no activity yet"
  const lines0 = comp.render(80);
  const flat0 = lines0.join("\n");
  assert(flat0.includes("no activity yet"), "3a: 'no activity yet' before any event");
  // feed an event, render again on the SAME component
  feedRawEvent("b1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "starting work" }] },
  });
  const lines1 = comp.render(80);
  const flat1 = lines1.join("\n");
  assert(flat1.includes("starting work"), "3b: new event appears on the next render");
  assert(flat1.includes("developer"), "3c: header shows the role label");
  // Esc → close
  comp.handleInput("\x1b");
  assert(doneResults.includes("close"), "3d: Esc → done('close')");
  // s → steer
  const comp2 = createLiveViewComponent(
    "b1",
    () => undefined,
    fakeTheme,
    (r) => doneResults.push(`steer-${r}`),
  );
  comp2.handleInput("s");
  assert(doneResults.includes("steer-steer"), "3e: 's' → done('steer')");
  dropBuffer("b1");
}

// ---------------------------------------------------------------------------
// 4. Scroll: ↑/↓ pause and resume following.
// ---------------------------------------------------------------------------
{
  resetBuffers();
  startBuffer("b2");
  for (let i = 0; i < 10; i++) {
    feedRawEvent("b2", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `line-${i}` }] },
    });
  }
  const doneResults: string[] = [];
  const comp = createLiveViewComponent(
    "b2",
    () => undefined,
    fakeTheme,
    (r) => doneResults.push(r),
  );
  // Initially following (offset 0): render shows the last 10 events.
  let flat = comp.render(80).join("\n");
  assert(flat.includes("line-9"), "4a: following shows the newest event");
  // ↑ → pause (offset 1): the newest line scrolls off.
  comp.handleInput("\x1b[A");
  flat = comp.render(80).join("\n");
  assert(flat.includes("paused"), "4b: ↑ pauses following (footer shows 'paused')");
  // ↓ → resume (offset 0).
  comp.handleInput("\x1b[B");
  flat = comp.render(80).join("\n");
  assert(flat.includes("line-9"), "4c: ↓ resumes following");
  // End → resume.
  comp.handleInput("\x1b[A"); // pause again
  comp.handleInput("\x1b[F"); // End
  flat = comp.render(80).join("\n");
  assert(flat.includes("line-9"), "4d: End resumes following");
  dropBuffer("b2");
}

// ---------------------------------------------------------------------------
// 5. Buffer freed on dropBuffer (clear).
// ---------------------------------------------------------------------------
function testDropBuffer() {
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
testDropBuffer();

// ---------------------------------------------------------------------------
// 6. Quiet mode: no buffer created.
// ---------------------------------------------------------------------------
function testQuietMode() {
  resetBuffers();
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  startBuffer("b1");
  assert(!hasBuffer("b1"), "6a: quiet mode → startBuffer creates no buffer");
  feedRawEvent("b1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x" }] },
  });
  assert(!hasBuffer("b1"), "6b: quiet mode → feedRawEvent is a no-op");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_QUIET_STATUS");
}
testQuietMode();

// ---------------------------------------------------------------------------
// 6b. clearEntry drops the buffer — co-located lifecycle.
// ---------------------------------------------------------------------------
function testClearEntryDropsBuffer() {
  resetBuffers();
  reset();
  startBuffer("deck-job-1");
  startEntry("deck-job-1", { label: "developer", role: "developer" });
  assert(hasBuffer("deck-job-1"), "6b-a: buffer exists while the entry is alive");
  clearEntry("deck-job-1");
  assert(!hasBuffer("deck-job-1"), "6b-b: clearEntry drops the buffer (co-located)");
  assert(bufferCount() === 0, "6b-c: buffer count is 0 after clearEntry");
  detach();
}
testClearEntryDropsBuffer();

// ---------------------------------------------------------------------------
// 6c. Sync-throw exception safety (startJob + startBatch)
//     The new Promise wrapper turns a sync throw into a rejection that flows
//     through the existing settle handlers — no special branches.
// ---------------------------------------------------------------------------
async function testStartJobSyncThrow() {
  resetBuffers();
  reset();
  const fakePi = { sendUserMessage: () => {} } as never;
  let threwSync = false;
  let completionRejected = false;
  try {
    const handle = startJob(fakePi, {
      label: "sync-throw-job",
      role: "developer",
      work: () => {
        throw new Error("sync work failure");
      },
    });
    await handle.completion;
  } catch (err) {
    completionRejected = err instanceof Error && err.message === "sync work failure";
  }
  assert(!threwSync, "6c-a: sync throw does not propagate from startJob");
  assert(completionRejected, "6c-b: throw becomes a rejection of the job promise");
  await new Promise((r) => setTimeout(r, 10));
  const leaked = snapshot().find((e) => e.label === "sync-throw-job");
  assert(!leaked, "6c-c: no deck entry leaked");
  assert(bufferCount() === 0, "6c-d: buffer count is 0 after the sync throw");
  detach();
}
async function testStartBatchLastMemberSyncThrow() {
  resetBuffers();
  reset();
  const inbox: string[] = [];
  const fakePi = { sendUserMessage: (c: string) => inbox.push(c) } as never;
  startBatch(fakePi, {
    batchLabel: "sync-throw-batch",
    members: [
      { label: "member-ok", role: "explore", work: async () => ({ role: "explore", ok: true, ms: 5, text: "member-ok done" }) },
      { label: "member-sync-throw", role: "developer", work: () => { throw new Error("batch sync work failure"); } },
    ],
  });
  await new Promise((r) => setTimeout(r, 100));
  assert(inbox.length === 1, "6d-a: ONE consolidated batch report delivered");
  assert(
    inbox[0]?.includes("batch") && inbox[0].includes("member-sync-throw"),
    "6d-b: batch report names the failing member",
  );
  assert(
    batchSnapshot().find((b) => b.label === "member-ok") === undefined,
    "6d-c: member deck entry cleared",
  );
  assert(batchSnapshot().length === 0, "6d-d: batch entry cleared");
  assert(bufferCount() === 0, "6d-e: buffer count is 0");
  detach();
}
// Await both before section 7's `reset()` clears the deck entries.
await testStartJobSyncThrow();
await testStartBatchLastMemberSyncThrow();

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
  const customCalls: Array<{ overlay?: boolean }> = [];
  const editorCalls: string[] = [];
  const fakeCtx = {
    hasUI: true,
    ui: {
      custom: (_factory: unknown, opts?: { overlay?: boolean }) => {
        customCalls.push(opts ?? {});
        return Promise.resolve("close");
      },
      editor: (_title: string, _prefill: string) => {
        editorCalls.push(_title);
        return Promise.resolve(undefined);
      },
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof onRowConfirm>[0];
  await onRowConfirm(fakeCtx, "deck-job-1", rowHost());
  assert(customCalls.length === 1, "7a: running row with buffer → custom called once");
  assert(customCalls[0]?.overlay === true, "7b: custom called with overlay:true");
  assert(editorCalls.length === 0, "7c: no steer prompt (no editor call)");
  clearEntry("deck-job-1");
  dropBuffer("deck-job-1");

  // --- 7b: running row WITHOUT buffer → steer prompt directly, no custom
  startEntry("deck-job-2", { label: "explore", role: "explore" });
  const customCalls2: unknown[] = [];
  const editorCalls2: string[] = [];
  const fakeCtx2 = {
    hasUI: true,
    ui: {
      custom: (_f: unknown, o?: unknown) => {
        customCalls2.push(o);
        return Promise.resolve("close");
      },
      editor: (t: string, _p: string) => {
        editorCalls2.push(t);
        return Promise.resolve("hello");
      },
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof onRowConfirm>[0];
  await onRowConfirm(fakeCtx2, "deck-job-2", rowHost());
  assert(customCalls2.length === 0, "7d: running row without buffer → no custom call");
  assert(editorCalls2.length === 1, "7e: steer prompt opened directly (editor called)");
  clearEntry("deck-job-2");
  detach();

  // --- 7f: a REJECTING editor is caught inside openSteerPrompt — onRowConfirm
  //     resolves (the throw never escapes into the roster input handler).
  startEntry("deck-job-4", { label: "explore", role: "explore" });
  const fakeCtx4 = {
    hasUI: true,
    ui: {
      custom: (_f: unknown, _o?: unknown) => Promise.resolve("close"),
      editor: (_t: string, _p: string) => Promise.reject(new Error("editor unsupported")),
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof onRowConfirm>[0];
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
// ---------------------------------------------------------------------------
// 9. Exception safety: feedRawEvent never throws on bounded inputs.
// ---------------------------------------------------------------------------
{
  resetBuffers();
  startBuffer("b9");
  let threw = false;
  try {
    // Even a malformed / huge event must not throw from pushEvent.
    feedRawEvent("b9", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(10_000) }] },
    });
  } catch {
    threw = true;
  }
  assert(!threw, "9a: feedRawEvent does not throw on large input");
  assert(getBuffer("b9")?.length === 1, "9b: one event buffered");
  assert(
    (getBuffer("b9")[0] as { text: string }).text.length <= 400,
    "9c: truncation bounds the ring entry",
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
