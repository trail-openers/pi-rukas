#!/usr/bin/env bun
/**
 * #914 — the quiet-mode gate relocation (issue #914 / the adversarial round).
 *
 * Moved VERBATIM from agent-list.ts (section "8. Quiet-mode gate relocation")
 * into a smoke test. The `PI_ENSEMBLE_QUIET_STATUS` early return that lived
 * in dispatch-deck-live.ts `startBuffer` is REMOVED — buffers are ALWAYS
 * created, because quiet mode now only suppresses the PASSIVE deck widget
 * (dispatch-deck.ts `renderNow`); the agent list / roster still open the
 * live view for a quiet session's rows. This block is the guard against
 * regressing the relocation: it pins the two gates in opposite directions
 * and proves the quiet gate CHANGED (buffers created) while the one that
 * KEPT (the widget) is still suppressed.
 *
 * The only edits from the original block: imports (this is now a standalone
 * test file), the env restore uses `delete` when the saved value is
 * undefined (Node stores the string "undefined" on assignment), and a canary
 * asserting the block did not re-enter production code.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAIN_ROW_KEY, buildAgentListLines } from "../src/agent-list.ts";
import { buffers, startBuffer } from "../src/dispatch-deck-live.ts";
import { suppressWidgetIfQuiet } from "../src/dispatch-deck-quiet.ts";
import type { DeckEntry } from "../src/dispatch-deck.ts";
import { emptyRunningState } from "../src/progress.ts";

let exit = 0;
function fail(msg: string): void {
  console.error(`✗ ${msg}`);
  exit = 1;
}
function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

// A minimal fake ctx for the quiet gate test (suppressWidgetIfQuiet calls
// ctx.ui.setWidget when the widget is visible — here it is not, so the
// call is a no-op; the fake needs the shape for the type, not the call).
const fakeCtxWithUi = {
  ui: { setWidget: () => {}, notify: () => {} },
  hasUI: true,
} as unknown as ExtensionContext;

// ---------------------------------------------------------------------------
// 8. Quiet-mode gate relocation (issue #914 / the adversarial round).
//    The `PI_ENSEMBLE_QUIET_STATUS` early return that lived in
//    dispatch-deck-live.ts `startBuffer` is REMOVED — buffers are ALWAYS
//    created, because quiet mode now only suppresses the PASSIVE deck
//    widget (dispatch-deck.ts `renderNow`); the agent list / roster still
//    open the live view for a quiet session's rows. This block is the
//    guard against regressing the relocation: it pins the two gates in
//    opposite directions and proves the quiet gate CHANGED (buffers
//    created) while the one that KEPT (the widget) is still suppressed.
// ---------------------------------------------------------------------------
{
  const NOW = 2_000_000;
  const entries: DeckEntry[] = [
    {
      key: "job-q",
      label: "Q",
      state: emptyRunningState("developer"),
      seq: 0,
      startedAt: NOW - 60_000,
    },
  ];
  const quietSaved = process.env.PI_ENSEMBLE_QUIET_STATUS;
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  try {
    // The quiet gate that CHANGED: startBuffer no longer early-returns.
    // The buffer is created and the live view is available for a quiet
    // session's rows (the list opens it via onRowConfirm, which reads the
    // buffer — a quiet session with no buffer would fall through to the
    // steer prompt, which is itself quiet-gated in dispatch-deck-interactive.
    // The buffer existing is the load-bearing fact: it is the data the
    // live view renders, and its absence was the old quiet gate's effect.
    startBuffer("job-q");
    const buf = buffers.get("job-q");
    if (!buf || buf.length !== 0) {
      fail("8a: quiet mode still suppresses startBuffer (the gate was moved) — buffer absent");
    } else {
      pass("8a: startBuffer creates a buffer in quiet mode (the gate moved)");
    }

    // The quiet gate that KEPT: renderNow still suppresses the widget.
    // `suppressWidgetIfQuiet` returns true while quiet, so renderNow
    // returns early and the deck widget is never set. It reads and writes
    // its own module-level state (no injected callbacks — #914).
    const quietSuppressed = suppressWidgetIfQuiet(fakeCtxWithUi, "ensemble:deck");
    if (!quietSuppressed) {
      fail("8b: suppressWidgetIfQuiet returned false in quiet mode (the kept gate is gone)");
    } else {
      pass("8b: suppressWidgetIfQuiet still suppresses the widget in quiet mode (the kept gate)");
    }

    // The agent list is reachable in quiet mode (the global shortcut is
    // registered regardless — index.ts); the list's own rows project
    // normally. This is the load-bearing fact for a quiet session: the
    // operator can open the list and the live view without the widget.
    const lines = buildAgentListLines(entries, [], 80, NOW);
    if (lines.length !== 2 || lines[0]?.key !== MAIN_ROW_KEY || lines[1]?.key !== "job-q") {
      fail("8c: agent list does not project rows in quiet mode");
    } else {
      pass("8c: the agent list projects its rows in quiet mode (the list is live)");
    }

    // The live view opens for a quiet session's row: the buffer exists
    // (proven above) and the live-view component reads it on every
    // render (dispatch-deck-live.ts) — the openLiveView route in
    // onRowConfirm does not gate on quiet mode. This is the behavioural
    // consequence of the gate relocation.
    const liveViewAvailable = buf !== undefined;
    if (!liveViewAvailable) {
      fail("8d: the live view is unavailable for a quiet session's row");
    } else {
      pass("8d: the live view is available for a quiet session's row (the gate moved)");
    }
  } finally {
    if (quietSaved === undefined) delete process.env.PI_ENSEMBLE_QUIET_STATUS;
    else process.env.PI_ENSEMBLE_QUIET_STATUS = quietSaved;
    buffers.delete("job-q");
  }
}

// ---------------------------------------------------------------------------
// 8e. Canary: agent-list.ts must contain no process.exit and no
//     process.env.PI_ENSEMBLE_QUIET_STATUS assignment (the quiet-gate
//     test block must not re-enter production code).
// ---------------------------------------------------------------------------
{
  const srcPath = join(dirname(import.meta.path), "..", "src", "agent-list.ts");
  const src = readFileSync(srcPath, "utf8");
  if (src.includes("process.exit")) {
    fail("8e: agent-list.ts contains process.exit (the quiet-gate block re-entered production code)");
  } else {
    pass("8e: agent-list.ts contains no process.exit");
  }
  if (src.includes("process.env.PI_ENSEMBLE_QUIET_STATUS =")) {
    fail("8e: agent-list.ts assigns process.env.PI_ENSEMBLE_QUIET_STATUS (the quiet-gate block re-entered production code)");
  } else {
    pass("8e: agent-list.ts contains no process.env.PI_ENSEMBLE_QUIET_STATUS assignment");
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
