#!/usr/bin/env bun
/**
 * #916 SLICE A — the live-buffer data layer: untruncated storage, the 512 KB
 * byte bound (oldest-first eviction), the thinking variant, settle status,
 * append notifications, and the view-open buffer lifetime.
 *
 * test-dispatch-deck-live.ts is at the 500-line file-size cap, so the NEW
 * assertions live here (the old file gets only the mandated before/after
 * rewrites). The /runs surface is pinned separately (block h) — the live
 * view's full-fidelity storage does not touch transcript-preview-limits.ts.
 */

import {
  LIVE_BUFFER_MAX_BYTES,
  bufferCount,
  createLiveViewComponent,
  dropBuffer,
  feedRawEvent,
  getBuffer,
  getStatus,
  hasBuffer,
  isViewOpen,
  markSettled,
  markViewClosed,
  markViewOpen,
  onBufferAppend,
  startBuffer,
} from "../src/dispatch-deck-live.ts";
import { clearEntry, reset, startEntry } from "../src/dispatch-deck.ts";
import {
  TOOL_ARGS_PREVIEW_MAX,
  TOOL_RESULT_LINE_MAX,
  TOOL_RESULT_PREVIEW_MAX,
} from "../src/transcript-preview-limits.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function resetBuffers(keys: string[]): void {
  for (const k of keys) dropBuffer(k);
}

// ---------------------------------------------------------------------------
// (a) Full fidelity: 1,000-char text and 1,000-char args survive
//     feed → buffer verbatim.
// ---------------------------------------------------------------------------
{
  resetBuffers(["a1"]);
  startBuffer("a1");
  const longText = `word`.repeat(250); // 1,000 chars
  const args = { command: "echo " + "a".repeat(984) }; // args JSON > 1,000 chars
  feedRawEvent("a1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: longText }] },
  });
  feedRawEvent("a1", {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: args }],
    },
  });
  const buf = getBuffer("a1");
  assert(buf.length === 2, `a0: two events buffered (got ${buf.length})`);
  assert(buf[0]?.kind === "text" && buf[0].text === longText, "a1: 1,000-char text stored verbatim");
  assert(
    buf[1]?.kind === "toolCall" && buf[1].args === JSON.stringify(args),
    "a2: 1,000-char args stored as full JSON, verbatim",
  );
  dropBuffer("a1");
}

// ---------------------------------------------------------------------------
// (b) Byte bound: 100 events × 50 KB → stored total ≤ 512 KB, the newest
//     events that do not fit are evicted, the newest retained.
// ---------------------------------------------------------------------------
{
  resetBuffers(["b1"]);
  startBuffer("b1");
  const chunk = "p".repeat(50 * 1024); // 50 KB
  for (let i = 0; i < 100; i++) {
    feedRawEvent("b1", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: chunk }] },
    });
  }
  const buf = getBuffer("b1");
  let total = 0;
  for (const ev of buf) {
    total +=
      ev.kind === "text" ? ev.text.length : ev.kind === "toolCall" ? ev.args.length : ev.text.length;
  }
  assert(total <= LIVE_BUFFER_MAX_BYTES, `b1: stored total ≤ 512 KB (got ${total} B)`);
  assert(buf.length >= 1 && buf.length < 100, `b2: events that did not fit evicted (kept ${buf.length})`);
  assert(buf[buf.length - 1]?.text === chunk, "b3: newest event retained in full");
  dropBuffer("b1");
}

// ---------------------------------------------------------------------------
// (c) A single event larger than the bound is kept ALONE, untruncated.
// ---------------------------------------------------------------------------
{
  resetBuffers(["c1"]);
  startBuffer("c1");
  const big = "q".repeat(600 * 1024); // 600 KB > 512 KB bound
  feedRawEvent("c1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: big }] },
  });
  const buf = getBuffer("c1");
  assert(buf.length === 1, "c1: oversized event kept alone");
  assert(buf[0]?.text === big, "c2: oversized event untruncated (full 600 KB)");
  // A second, smaller event is evicted by the oversized one (oldest-first);
  // the oversized event is retained ALONE, untruncated — the bound caps the
  // total across events, never a lone event (PM decision, #916).
  feedRawEvent("c1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "smaller" }] },
  });
  const buf2 = getBuffer("c1");
  assert(buf2.length === 1 && buf2[0]?.text === big, "c3: oversized event retained alone after a later event");
  dropBuffer("c1");
}

// ---------------------------------------------------------------------------
// (d) Thinking blocks: stored as the thinking variant; the view line shows
//     "▸ thinking (N chars)" with N = the raw character count.
// ---------------------------------------------------------------------------
{
  resetBuffers(["d1"]);
  startBuffer("d1");
  const think = "hmm".repeat(120); // 480 chars of raw thinking
  feedRawEvent("d1", {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: think }],
    },
  });
  const buf = getBuffer("d1");
  assert(buf.length === 1 && buf[0]?.kind === "thinking", "d1: thinking block stored as thinking variant");
  assert(buf[0]?.text === think, "d2: thinking text stored in full");
  const fakeTheme = { muted: (t: string) => t, error: (t: string) => t } as const;
  const comp = createLiveViewComponent("d1", () => undefined, fakeTheme, () => {});
  const flat = comp.render(80).join("\n");
  assert(flat.includes(`▸ thinking (${think.length} chars)`), "d3: view shows '▸ thinking (N chars)' with raw count");
  dropBuffer("d1");
}

// ---------------------------------------------------------------------------
// (e) markSettled / getStatus.
// ---------------------------------------------------------------------------
{
  resetBuffers(["e1"]);
  startBuffer("e1");
  assert(getStatus("e1") === "running", "e1: fresh buffer reports running");
  markSettled("e1", "finished");
  assert(getStatus("e1") === "finished", "e2: markSettled('finished') is visible");
  markSettled("e1", "failed");
  assert(getStatus("e1") === "failed", "e3: markSettled('failed') overwrites");
  markSettled("e1", "killed");
  assert(getStatus("e1") === "killed", "e4: markSettled('killed') is visible");
  dropBuffer("e1");
  assert(getStatus("e1") === "running", "e5: dropBuffer clears the settle status");
  assert(getStatus("never-existed") === "running", "e6: unknown key defaults to running");
}

// ---------------------------------------------------------------------------
// (f) onBufferAppend: fires on feed, stops after unsubscribe, and a
//     throwing subscriber does not break the feed.
// ---------------------------------------------------------------------------
{
  resetBuffers(["f1"]);
  startBuffer("f1");
  let calls = 0;
  const unsub = onBufferAppend("f1", () => {
    calls += 1;
  });
  feedRawEvent("f1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "one" }] },
  });
  assert(calls === 1, "f1: subscriber fired on feed");
  unsub();
  feedRawEvent("f1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "two" }] },
  });
  assert(calls === 1, "f2: subscriber stopped after unsubscribe");
  assert(getBuffer("f1").length === 2, "f3: the buffer still received both events");
  // A throwing subscriber must not break the feed path.
  let threw = false;
  try {
    const bad = onBufferAppend("f1", () => {
      throw new Error("subscriber exploded");
    });
    feedRawEvent("f1", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "three" }] },
    });
    bad();
  } catch {
    threw = true;
  }
  assert(!threw, "f4: throwing subscriber is caught (no throw escapes)");
  assert(getBuffer("f1").length === 3, "f5: feed continued past the throwing subscriber");
  dropBuffer("f1");
}

// ---------------------------------------------------------------------------
// (g) Buffer lifetime vs view open:
//     clearEntry keeps the buffer while the view is open; markViewClosed
//     then drops it (the entry is already cleared); clearEntry with no view
//     still drops it (no leak).
// ---------------------------------------------------------------------------
{
  resetBuffers(["g1", "g2"]);
  reset();
  // g1: view open at clearEntry time → buffer survives, dropped on close.
  startBuffer("g1");
  startEntry("g1", { label: "developer", role: "developer" });
  feedRawEvent("g1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "g1 activity" }] },
  });
  markViewOpen("g1");
  assert(isViewOpen("g1"), "g1a: view marked open");
  clearEntry("g1");
  assert(hasBuffer("g1"), "g1b: clearEntry KEEPS the buffer while the view is open");
  assert(getBuffer("g1").length === 1, "g1c: buffer content intact after clearEntry");
  markViewClosed("g1");
  assert(!hasBuffer("g1"), "g1d: markViewClosed drops the buffer (entry already cleared)");
  assert(!isViewOpen("g1"), "g1e: view no longer open after close");
  // g2: no view at clearEntry time → buffer dropped as before (no leak).
  startBuffer("g2");
  startEntry("g2", { label: "explore", role: "explore" });
  feedRawEvent("g2", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "g2 activity" }] },
  });
  assert(!isViewOpen("g2"), "g2a: no view marked open");
  clearEntry("g2");
  assert(!hasBuffer("g2"), "g2b: clearEntry drops the buffer when no view is open");
  assert(bufferCount() === 0, "g2c: buffer count is 0 — no leak");
  reset();
}

// ---------------------------------------------------------------------------
// (h) /runs surface untouched: transcript-preview-limits.ts constants still
//     400 / 240 / 200 (the live view's full-fidelity storage uses its own
//     LIVE_BUFFER_MAX_BYTES; runs-viewer.ts is not modified).
// ---------------------------------------------------------------------------
{
  assert(TOOL_RESULT_PREVIEW_MAX === 400, "h1: TOOL_RESULT_PREVIEW_MAX is still 400");
  assert(TOOL_ARGS_PREVIEW_MAX === 240, "h2: TOOL_ARGS_PREVIEW_MAX is still 240");
  assert(TOOL_RESULT_LINE_MAX === 200, "h3: TOOL_RESULT_LINE_MAX is still 200");
  assert(LIVE_BUFFER_MAX_BYTES === 512 * 1024, "h4: LIVE_BUFFER_MAX_BYTES is the 512 KB bound");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
