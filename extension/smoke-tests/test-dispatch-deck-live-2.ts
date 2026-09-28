#!/usr/bin/env bun
/**
 * #839 — live view of a running subagent's activity (dispatch deck, epic
 * #833 G5). Quiet mode test extracted from test-dispatch-deck-live.ts.
 *
 * #914 — quiet-mode decision: buffers are now ALWAYS created (the
 * startBuffer quiet early-return was REMOVED — quiet mode only suppresses
 * the passive deck widget, not the live view). Sections 6a/6b therefore
 * FLIP from "no buffer" to "buffer exists" with this before/after record:
 *   6a before: `!hasBuffer("b1")` — "quiet mode → startBuffer creates no buffer"
 *   6a after:  `hasBuffer("b1")` — "quiet mode → startBuffer STILL creates the buffer (#914)"
 *   6b before: `!hasBuffer("b1")` — "quiet mode → feedRawEvent is a no-op"
 *   6b after:  `hasBuffer("b1")` — "quiet mode → feedRawEvent stores events (#914)"
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
// 6. Quiet mode: buffer STILL created (#914 — the startBuffer quiet gate
//    was removed; quiet now only suppresses the passive deck widget).
// ---------------------------------------------------------------------------
function testQuietMode() {
  resetBuffers();
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  startBuffer("b1");
  assert(hasBuffer("b1"), "6a: quiet mode → startBuffer STILL creates the buffer (#914)");
  feedRawEvent("b1", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x" }] },
  });
  assert(hasBuffer("b1"), "6b: quiet mode → feedRawEvent stores events (#914)");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_QUIET_STATUS");
}
testQuietMode();

process.exit(exit);
