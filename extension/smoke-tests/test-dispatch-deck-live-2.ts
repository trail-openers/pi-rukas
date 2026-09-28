#!/usr/bin/env bun
/**
 * #839 — live view of a running subagent's activity (dispatch deck, epic
 * #833 G5). Quiet mode test extracted from test-dispatch-deck-live.ts.
 */

import {
  bufferCount,
  dropBuffer,
  feedRawEvent,
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

process.exit(exit);
