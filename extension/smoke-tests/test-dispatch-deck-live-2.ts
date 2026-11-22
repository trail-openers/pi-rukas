#!/usr/bin/env bun
/**
 * #839 — live view of a running subagent's activity (dispatch deck, epic
 * #833 G5). Quiet mode test extracted from test-dispatch-deck-live.ts, and
 * the recorded tool duration on a toolResult row.
 */

import { eventLines } from "../src/dispatch-deck-live-view-render.ts";
import {
  bufferCount,
  dropBuffer,
  feedRawEvent,
  getBuffer,
  hasBuffer,
  startBuffer,
} from "../src/dispatch-deck-live.ts";
import { reset } from "../src/dispatch-deck.ts";

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
// 6. Quiet mode: no buffer created.
// ---------------------------------------------------------------------------
function testQuietMode() {
  resetBuffers();
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  startBuffer("b1");
  // #914 — quiet-mode decision: the startBuffer quiet early-return was REMOVED
  // (buffers are now ALWAYS created — quiet mode only suppresses the PASSIVE
  // deck widget, not the live view). This assertion flips from "no buffer"
  // to "buffer exists" to document that change.
  assert(hasBuffer("b1"), "6a: quiet mode → startBuffer STILL creates the buffer (#914)");
  feedRawEvent("b1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x" }] },
  });
  // #914 — feedRawEvent now stores events in quiet mode too (the buffer
  // exists, so events are buffered; the live view is reachable).
  assert(hasBuffer("b1"), "6b: quiet mode → feedRawEvent stores events (#914)");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_QUIET_STATUS");
}
testQuietMode();

// ---------------------------------------------------------------------------
// 7. A toolResult row shows Pi's recorded durationMs; without it the row is
//     unchanged.
// ---------------------------------------------------------------------------
{
  const key = "feed-duration";
  dropBuffer(key);
  startBuffer(key);
  const result = (extra: Record<string, unknown>) =>
    feedRawEvent(key, {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        ...extra,
      },
    });
  result({ durationMs: 12_345 });
  result({ isError: true, durationMs: 800 });
  result({});
  const theme = { error: (s: string) => s, muted: (s: string) => s };
  const heads = getBuffer(key).map((ev) => eventLines(ev, 80, false, theme)[0]);
  assert(heads[0] === "✓ bash · 12.3s", `7a: recorded duration on the row (got ${heads[0]})`);
  assert(heads[1] === "✗ bash (error) · 800ms", `7b: on an error row too (got ${heads[1]})`);
  assert(heads[2] === "✓ bash", `7c: no durationMs → row unchanged (got ${heads[2]})`);
  assert(
    !("durationMs" in (getBuffer(key)[2] ?? {})),
    "7d: no durationMs → stored event unchanged",
  );
  dropBuffer(key);
}

process.exit(exit);
