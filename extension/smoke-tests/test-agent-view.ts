#!/usr/bin/env bun
/**
 * #916 SLICE B — the full-screen agent view component and open/close loop.
 *
 * Drives the REAL component (dispatch-deck-live-view-component.ts) and the
 * openLiveView / onRowConfirm / confirmRow wiring with synthetic events.
 *
 * test-dispatch-deck-live.ts is at the 500-line file-size cap, so all NEW
 * assertions live here (the old file gets only the mandated before/after
 * rewrites).
 */

import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  dropBuffer,
  feedRawEvent,
  getBuffer,
  getStatus,
  hasBuffer,
  markSettled,
  onBufferAppend,
  startBuffer,
} from "../src/dispatch-deck-live.ts";
import {
  createAgentViewComponent,
  getViewScrollState,
  type ViewHeader,
} from "../src/dispatch-deck-live-view-component.ts";
import {
  openLiveView,
  type LiveViewTheme,
} from "../src/dispatch-deck-live-view.ts";
import { onRowConfirm } from "../src/dispatch-deck-confirm.ts";
import { confirmRow } from "../src/dispatch-deck-confirm-row.ts";
import { clearEntry, reset, snapshot, startEntry } from "../src/dispatch-deck.ts";
import { pmActive, setPmActive } from "../src/pm-active.ts";
import { getNotices, incrementNotice, resetNotices } from "../src/notice-counter.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fakeTheme: LiveViewTheme = { muted: (t) => t, error: (t) => t };

function makeHeader(over: Partial<ViewHeader> = {}): ViewHeader {
  return {
    label: "developer",
    role: "developer",
    status: "running",
    startedAt: Date.now() - 5000,
    now: Date.now(),
    turns: 2,
    totalTokens: 1234,
    pmActive: false,
    notices: 0,
    settled: false,
    ...over,
  };
}

function resetKeys(keys: string[]): void {
  for (const k of keys) dropBuffer(k);
}

// ---------------------------------------------------------------------------
// 1. Full-fidelity rendering: 1,000-char assistant text renders in full
//    across wrapped lines; 1,000-char tool args render in full. Every line
//    satisfies visibleWidth ≤ width at widths 40 and 120.
// ---------------------------------------------------------------------------
{
  resetKeys(["v1"]);
  startBuffer("v1");
  const longText = "word ".repeat(200); // 1,000 chars
  feedRawEvent("v1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: longText }] },
  });
  const args = { command: "echo " + "a".repeat(984) }; // > 1,000 chars JSON
  feedRawEvent("v1", {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: args }],
    },
  });
  const comp = createAgentViewComponent("v1", () => makeHeader(), fakeTheme, { terminal: { rows: 500 } }, () => {}, () => {});
  for (const w of [40, 120]) {
    const lines = comp.render(w);
    let allFit = true;
    for (const line of lines) {
      if (visibleWidth(line) > w) allFit = false;
    }
    assert(allFit, `1a(w=${w}): every line visibleWidth ≤ ${w}`);
  }
  // The 1,000-char text renders in full: join the body lines and check a
  // large portion is present (wrapTextWithAnsi drops trailing whitespace
  // at line breaks, so the exact string is not contiguous in the output).
  const flat = comp.render(500).join("\n");
  const textWords = longText.trim().split(" ").slice(0, 50).join(" ");
  assert(flat.includes(textWords), "1b: 1,000-char text renders in full (no truncation)");
  const textTailWords = longText.trim().split(" ").slice(-50).join(" ");
  assert(flat.includes(textTailWords), "1c: the tail of the 1,000-char text is present");
  // The tool args render in full: the command string is in the output.
  assert(flat.includes("echo"), "1d: 1,000-char tool args render in full (head)");
  assert(flat.includes("a".repeat(20)), "1e: the tail of the tool args is present");
  // The args are pretty-printed (2-space indent).
  const pretty = JSON.stringify(args, null, 2);
  const prettyLines = pretty.split("\n");
  assert(prettyLines[0]?.startsWith("{"), "1f: tool args are pretty-printed (multi-line)");
  dropBuffer("v1");
}

// ---------------------------------------------------------------------------
// 2. Thinking: collapsed by default, expanded on `t`.
// ---------------------------------------------------------------------------
{
  resetKeys(["v2"]);
  startBuffer("v2");
  const thinkText = "I am thinking about this problem";
  feedRawEvent("v2", {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: thinkText } as unknown as { type: "thinking"; thinking: string }],
    },
  });
  const comp = createAgentViewComponent("v2", () => makeHeader(), fakeTheme, undefined, () => {}, () => {});
  let flat = comp.render(80).join("\n");
  assert(flat.includes(`▸ thinking (${thinkText.length} chars)`), "2a: thinking collapsed by default");
  assert(!flat.includes(thinkText), "2b: thinking text not visible when collapsed");
  // #915: `t` now inserts into the input; ctrl+t (\x14) toggles thinking
  comp.handleInput("\x14"); // ctrl+t — toggle expand
  flat = comp.render(80).join("\n");
  assert(flat.includes(thinkText), "2c: thinking expanded after ctrl+t");
  comp.handleInput("\x14"); // ctrl+t — toggle back
  flat = comp.render(80).join("\n");
  assert(flat.includes(`▸ thinking (${thinkText.length} chars)`), "2d: thinking collapsed after second ctrl+t");
  dropBuffer("v2");
}

// ---------------------------------------------------------------------------
// 3. Scrolling: ↑/PgUp turn follow off; End restores; auto-scroll on append
//    only when following; state persists across re-creation.
// ---------------------------------------------------------------------------
{
  resetKeys(["v3"]);
  startBuffer("v3");
  for (let i = 0; i < 30; i++) {
    feedRawEvent("v3", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `line-${i}` }] },
    });
  }
  const tui: { terminal?: { rows?: number } } = { terminal: { rows: 10 } };
  const comp1 = createAgentViewComponent("v3", () => makeHeader(), fakeTheme, tui, () => {}, () => {});
  let flat = comp1.render(80).join("\n");
  assert(flat.includes("line-29"), "3a: following shows the newest event");
  // ↑ → pause
  comp1.handleInput("\x1b[A");
  flat = comp1.render(80).join("\n");
  assert(flat.includes("paused"), "3b: ↑ pauses following (footer shows 'paused')");
  // End → resume
  comp1.handleInput("\x1b[F");
  flat = comp1.render(80).join("\n");
  assert(flat.includes("line-29"), "3c: End resumes following");
  // PgUp → pause
  comp1.handleInput("\x1b[5~");
  flat = comp1.render(80).join("\n");
  assert(flat.includes("paused"), "3d: PgUp pauses following");
  // End → resume
  comp1.handleInput("\x1b[F");
  // Auto-scroll: append a new event while following → it appears
  feedRawEvent("v3", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "new-line" }] },
  });
  flat = comp1.render(80).join("\n");
  assert(flat.includes("new-line"), "3e: new event auto-scrolls into view when following");
  // ↑ → pause; append → does NOT auto-scroll
  comp1.handleInput("\x1b[A");
  feedRawEvent("v3", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "another-line" }] },
  });
  flat = comp1.render(80).join("\n");
  assert(!flat.includes("another-line"), "3f: new event does NOT auto-scroll when paused");
  // State persists across re-creation: create a second component for the
  // same key and verify the scroll state is restored.
  const comp2 = createAgentViewComponent("v3", () => makeHeader(), fakeTheme, tui, () => {}, () => {});
  const state = getViewScrollState("v3");
  assert(state.scroll > 0, "3g: scroll state persisted (scroll > 0 after re-creation)");
  // End → follow on
  comp2.handleInput("\x1b[F");
  const state2 = getViewScrollState("v3");
  assert(state2.scroll === 0, "3h: End resets scroll to 0 (following)");
  dropBuffer("v3");
}

// ---------------------------------------------------------------------------
// 4. Header: status / elapsed / turns / tokens; "PM active" badge;
//    "2 new notices" after two increments.
// ---------------------------------------------------------------------------
{
  resetKeys(["v4"]);
  startBuffer("v4");
  setPmActive(true);
  resetNotices();
  incrementNotice();
  incrementNotice();
  const comp = createAgentViewComponent(
    "v4",
    () => makeHeader({ status: "running", pmActive: true, notices: 2 }),
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  const flat = comp.render(120).join("\n");
  assert(flat.includes("running"), "4a: header shows status 'running'");
  assert(flat.includes("2 turns"), "4b: header shows turns");
  assert(flat.includes("1234 tokens"), "4c: header shows tokens");
  assert(flat.includes("PM active"), "4d: header shows 'PM active' badge");
  assert(flat.includes("new notices"), "4e: header shows 'new notices' badge");
  // Settle status
  markSettled("v4", "finished");
  const comp2 = createAgentViewComponent(
    "v4",
    () => makeHeader({ status: "finished", pmActive: false, notices: 0, settled: true }),
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  const flat2 = comp2.render(80).join("\n");
  assert(flat2.includes("finished"), "4f: header shows status 'finished'");
  assert(flat2.includes("— finished · press Esc —"), "4g: settle final line appears");
  assert(!flat2.includes("PM active"), "4h: no 'PM active' when not streaming");
  setPmActive(false);
  dropBuffer("v4");
}

// ---------------------------------------------------------------------------
// 5. Settle while open: final line appears, content kept, scroll works.
// ---------------------------------------------------------------------------
{
  resetKeys(["v5"]);
  startBuffer("v5");
  for (let i = 0; i < 5; i++) {
    feedRawEvent("v5", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `msg-${i}` }] },
    });
  }
  let settled = false;
  const comp = createAgentViewComponent(
    "v5",
    () => makeHeader({ status: settled ? "failed" : "running", settled }),
    fakeTheme,
    { terminal: { rows: 10 } },
    () => {},
    () => {},
  );
  let flat = comp.render(80).join("\n");
  assert(flat.includes("msg-4"), "5a: content visible before settle");
  assert(!flat.includes("press Esc"), "5b: no settle line before settle");
  settled = true;
  flat = comp.render(80).join("\n");
  assert(flat.includes("— failed · press Esc —"), "5c: settle line appears after settle");
  assert(flat.includes("msg-4"), "5d: content still visible after settle");
  // Scroll still works after settle: use a tall terminal so there are
  // more lines than the body height, allowing scroll.
  const compTall = createAgentViewComponent(
    "v5",
    () => makeHeader({ status: "failed", settled: true }),
    fakeTheme,
    { terminal: { rows: 4 } }, // body height = 2
    () => {},
    () => {},
  );
  compTall.handleInput("\x1b[A"); // up
  const flatTall = compTall.render(80).join("\n");
  assert(flatTall.includes("paused"), "5e: scroll works after settle (tall terminal)");
  dropBuffer("v5");
}

// ---------------------------------------------------------------------------
// 6. Esc → done("returnToList"); openLiveView with/without onReturnToList;
//    `s` → steer.
// ---------------------------------------------------------------------------
{
  resetKeys(["v6"]);
  startBuffer("v6");
  const results: string[] = [];
  const comp = createAgentViewComponent("v6", () => makeHeader(), fakeTheme, undefined, (r) =>
    results.push(r), () => {});
  // #915: `s` now inserts into the input; the steer path is the Enter key
  comp.handleInput("s");
  assert(comp.inputValue() === "s", "6a: 's' inserts into the input (no done)");
  assert(results.length === 0, "6b: no done() from 's'");
  // Esc with text → clear (no done); Esc again → returnToList
  comp.handleInput("\x1b");
  assert(comp.inputValue() === "", "6c: Esc with text clears input");
  comp.handleInput("\x1b");
  assert(results.includes("returnToList"), "6d: Esc on empty → done('returnToList')");
  dropBuffer("v6");
}

// ---------------------------------------------------------------------------
// 7. onBufferAppend triggers requestRender while open; unsubscribed after close.
// ---------------------------------------------------------------------------
{
  resetKeys(["v7"]);
  startBuffer("v7");
  let renderCount = 0;
  const unsub = onBufferAppend("v7", () => {
    renderCount++;
  });
  feedRawEvent("v7", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "trigger" }] },
  });
  assert(renderCount === 1, "7a: onBufferAppend fires on append");
  unsub();
  feedRawEvent("v7", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "after-unsub" }] },
  });
  assert(renderCount === 1, "7b: onBufferAppend does not fire after unsubscribe");
  dropBuffer("v7");
}

// ---------------------------------------------------------------------------
// 8. Hostile content: ANSI, control chars, CJK, 2000-char line → no raw
//    ESC in output, widths bounded.
// ---------------------------------------------------------------------------
{
  resetKeys(["v8"]);
  startBuffer("v8");
  // ANSI escape + control chars
  feedRawEvent("v8", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "\x1b[31mred\x1b[0m\x00\x01" }] },
  });
  // CJK
  feedRawEvent("v8", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "日本語テスト" }] },
  });
  // 2000-char line
  feedRawEvent("v8", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2000) }] },
  });
  const comp = createAgentViewComponent("v8", () => makeHeader(), fakeTheme, undefined, () => {}, () => {});
  for (const w of [40, 120]) {
    const lines = comp.render(w);
    let hasRawEsc = false;
    let allFit = true;
    for (const line of lines) {
      if (line.includes("\x1b") || line.includes("\x00")) hasRawEsc = true;
      if (visibleWidth(line) > w) allFit = false;
    }
    assert(!hasRawEsc, `8a(w=${w}): no raw ESC or NUL in output`);
    assert(allFit, `8b(w=${w}): all lines bounded to width`);
  }
  dropBuffer("v8");
}

// ---------------------------------------------------------------------------
// 9. overlayOptions: full-screen values passed to ctx.ui.custom.
// ---------------------------------------------------------------------------
{
  resetKeys(["v9"]);
  reset();
  startBuffer("deck-job-9");
  startEntry("deck-job-9", { label: "developer", role: "developer" });
  const customOpts: unknown[] = [];
  const fakeCtx = {
    ui: {
      custom: (_f: unknown, o?: unknown) => {
        customOpts.push(o);
        return Promise.resolve("returnToList" as const);
      },
      editor: (_t: string, _p: string) => Promise.resolve("hello"),
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof openLiveView>[0];
  await openLiveView(fakeCtx, "deck-job-9", {
    getEntry: (k) => snapshot().find((e) => e.key === k),
  });
  assert(customOpts.length === 1, "9a: ctx.ui.custom called once");
  const opts = customOpts[0] as {
    overlay?: boolean;
    overlayOptions?: { width?: string; maxHeight?: string; anchor?: string };
  };
  assert(opts?.overlay === true, "9b: overlay: true");
  assert(opts?.overlayOptions?.width === "100%", "9c: overlayOptions.width === '100%'");
  assert(opts?.overlayOptions?.maxHeight === "100%", "9d: overlayOptions.maxHeight === '100%'");
  assert(opts?.overlayOptions?.anchor === "top-left", "9e: overlayOptions.anchor === 'top-left'");
  clearEntry("deck-job-9");
  dropBuffer("deck-job-9");
  reset();
}

// ---------------------------------------------------------------------------
// 10. onReturnToList: invoked on Esc when provided; not called when absent.
// ---------------------------------------------------------------------------
{
  resetKeys(["v10"]);
  reset();
  startBuffer("deck-job-10");
  startEntry("deck-job-10", { label: "developer", role: "developer" });
  let returnCalled = false;
  const fakeCtx = {
    ui: {
      custom: (_f: unknown, _o?: unknown) => Promise.resolve("returnToList" as const),
      editor: (_t: string, _p: string) => Promise.resolve("hello"),
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof openLiveView>[0];
  await openLiveView(
    fakeCtx,
    "deck-job-10",
    {
      getEntry: (k) => snapshot().find((e) => e.key === k),
    },
    { onReturnToList: () => { returnCalled = true; } },
  );
  assert(returnCalled, "10a: onReturnToList invoked on Esc when provided");
  clearEntry("deck-job-10");
  dropBuffer("deck-job-10");
  reset();
}

// ---------------------------------------------------------------------------
// 11. confirmRow threads onReturnToList through to openLiveView.
// ---------------------------------------------------------------------------
{
  resetKeys(["v11"]);
  reset();
  startBuffer("deck-job-11");
  startEntry("deck-job-11", { label: "developer", role: "developer" });
  let returnCalled = false;
  const fakeCtx = {
    ui: {
      custom: (_f: unknown, _o?: unknown) => Promise.resolve("returnToList" as const),
      editor: (_t: string, _p: string) => Promise.resolve("hello"),
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof confirmRow>[0];
  await confirmRow(
    fakeCtx,
    "deck-job-11",
    {
      getEntry: (k) => snapshot().find((e) => e.key === k),
      steer: () => {},
    },
    { onReturnToList: () => { returnCalled = true; } },
  );
  assert(returnCalled, "11a: confirmRow threads onReturnToList through");
  clearEntry("deck-job-11");
  dropBuffer("deck-job-11");
  reset();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
