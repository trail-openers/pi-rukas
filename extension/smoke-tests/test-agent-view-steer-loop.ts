#!/usr/bin/env bun
/**
 * #916 SLICE B — steer re-open loop: exactly ONE live append subscription
 * per open (regression: a steer that re-opens the view must not stack a
 * second onBufferAppend subscription on the same key).
 */

import {
  feedRawEvent,
  startBuffer,
  dropBuffer,
} from "../src/dispatch-deck-live.ts";
import {
  openLiveView,
  type LiveViewTheme,
} from "../src/dispatch-deck-live-view.ts";
import { clearEntry, reset, snapshot, startEntry } from "../src/dispatch-deck.ts";

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

function resetKeys(keys: string[]): void {
  for (const k of keys) {
    clearEntry(k);
    dropBuffer(k);
  }
  reset();
}

// 12. Steer re-open loop: exactly ONE live append subscription per open.
{
  resetKeys(["deck-job-12"]); startBuffer("deck-job-12"); reset();
  startEntry("deck-job-12", { label: "developer", role: "developer" });
  let n = 0, rc = 0, d = -1, sc = 0;
  const ctx = { ui: {
    custom: (f: (t: unknown) => unknown) => {
      n++; const t = { requestRender: () => { rc++; } };
      f(t);
      if (n === 3) { const b = rc; feedRawEvent("deck-job-12", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }); d = rc - b; }
      return Promise.resolve(n <= 2 ? ("steer" as const) : ("returnToList" as const));
    },
    editor: () => Promise.resolve("steer"),
    setWidget: () => {}, getEditorText: () => "", onTerminalInput: () => () => {},
  } } as unknown as Parameters<typeof openLiveView>[0];
  const p = openLiveView(ctx, "deck-job-12", { getEntry: (k) => snapshot().find((e) => e.key === k), buildSteerPrompt: () => "", steer: () => { sc++; } });
  for (let i = 0; n < 3 && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
  assert(n === 3, "12a: custom called 3 times");
  assert(sc === 2, "12b: steer called twice");
  assert(d === 1, `12c: one append → one render (got ${d})`);
  await p;
  const after = rc;
  feedRawEvent("deck-job-12", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "y" }] } });
  assert(rc === after, "12d: no render after close");
  clearEntry("deck-job-12"); dropBuffer("deck-job-12"); reset();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
