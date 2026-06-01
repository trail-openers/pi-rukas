#!/usr/bin/env bun
/**
 * Pure unit test for the dispatch deck (#117):
 *  - entries inserted in stable insertion order
 *  - update mutates in place without reordering
 *  - clear drops the row at 0s (no linger)
 *  - overflow (>4) renders header + 4 detail rows + "+N more"
 *  - PI_ENSEMBLE_QUIET_STATUS=1 short-circuits everything
 *  - lastText is truncated and newline-flattened
 *
 * No Pi spawns. The deck's setStatus path is exercised by attaching a fake
 * ExtensionContext that records the most recent call.
 */

import {
  type DeckEntry,
  clearEntry,
  formatDeck,
  reset,
  snapshot,
  startEntry,
  updateEntry,
} from "../src/dispatch-deck.ts";
import { type RunningState, emptyRunningState } from "../src/progress.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeState(role: string, opts: Partial<RunningState> = {}): RunningState {
  return { ...emptyRunningState(role), ...opts, usage: { ...emptyRunningState(role).usage } };
}

// 1. Insertion order is preserved across updates.
{
  reset();
  startEntry("a", { label: "developer", role: "developer" });
  startEntry("b", { label: "explore", role: "explore" });
  startEntry("c", { label: "ops", role: "ops" });

  updateEntry("b", makeState("explore", { elapsedMs: 5000, lastToolName: "grep" }));
  updateEntry("a", makeState("developer", { elapsedMs: 8000, lastToolName: "bash", toolUses: 3 }));

  const keys = snapshot().map((e) => e.key);
  assert(JSON.stringify(keys) === '["a","b","c"]', "insertion order preserved after interleaved updates");
}

// 2. Update mutates in place; clear removes immediately.
{
  reset();
  startEntry("x", { label: "developer", role: "developer" });
  updateEntry("x", makeState("developer", { elapsedMs: 12000, lastToolName: "bash" }));
  assert(snapshot()[0]?.state.lastToolName === "bash", "update set lastToolName");

  clearEntry("x");
  assert(snapshot().length === 0, "clear drops the entry immediately (no 0s linger)");
}

// 3. formatDeck renders a single row with icon + label + elapsed + tool + lastText.
{
  const entries: DeckEntry[] = [
    {
      key: "a",
      label: "developer",
      state: makeState("developer", {
        elapsedMs: 134000,
        lastToolName: "bash",
        toolUses: 7,
        lastText: "Running test suite in worktree-A",
      }),
    },
  ];
  const out = formatDeck(entries);
  assert(out.startsWith("⏳"), "row starts with hourglass icon");
  assert(out.includes("developer"), "row includes label");
  assert(out.includes("2m14s"), "row includes elapsed");
  assert(out.includes("bash (#7)"), "row includes tool name + use-count when >1");
  assert(out.includes("Running test suite"), "row includes lastText");
}

// 4. lastText truncation + newline flattening (≤60 chars, " · "-joined head).
{
  const longText =
    "This is a very long status message\nwith embedded newlines that should be flattened into a single line and then truncated when it exceeds the budget";
  const out = formatDeck([
    {
      key: "a",
      label: "explore",
      state: makeState("explore", { elapsedMs: 1000, lastText: longText }),
    },
  ]);
  // The header through " — " is at most ~25 chars; the trailing chunk is the
  // truncated text, capped at 60 chars including the ellipsis.
  const tail = out.slice(out.indexOf(" — ") + 3);
  assert(tail.length <= 60, `truncated tail length ≤60 (got ${tail.length}): "${tail}"`);
  assert(!tail.includes("\n"), "newlines flattened out of lastText");
  assert(tail.endsWith("…"), "long text ends with ellipsis");
}

// 5. <=4 entries: one line each, no overflow header.
{
  const entries: DeckEntry[] = ["a", "b", "c", "d"].map((k) => ({
    key: k,
    label: `agent-${k}`,
    state: makeState("developer", { elapsedMs: 1000 + 1000 * k.charCodeAt(0) }),
  }));
  const out = formatDeck(entries);
  const lines = out.split("\n");
  assert(lines.length === 4, "4 entries → exactly 4 lines (no header)");
  assert(!out.includes("more"), "no overflow line for exactly 4 entries");
}

// 6. >4 entries: overflow header + 4 detail rows (insertion-order, first 4) + "+N more".
{
  const entries: DeckEntry[] = ["a", "b", "c", "d", "e", "f"].map((k, i) => ({
    key: k,
    label: `agent-${k}`,
    state: makeState("developer", { elapsedMs: 1000 + i * 1000, lastToolName: "bash" }),
  }));
  const out = formatDeck(entries);
  const lines = out.split("\n");
  // Layout: header, 4 detail rows, 1 overflow summary = 6 lines total.
  assert(lines.length === 6, `overflow layout has 6 lines (got ${lines.length})`);
  assert(lines[0]?.startsWith("⏳ ensemble dispatch · 6 in flight"), "overflow header counts entries");
  assert(lines[0]?.includes("elapsed"), "overflow header shows oldest elapsed");
  assert(lines[1]?.startsWith(" ↳ "), "detail rows use arrow prefix");
  assert(lines[1]?.includes("agent-a"), "first detail row is insertion-order first");
  assert(lines[4]?.includes("agent-d"), "fourth detail row is fourth-inserted (not 'most recent')");
  assert(!out.includes("agent-e"), "fifth+ entries not shown directly");
  assert(lines[5]?.includes("(+2 more"), "overflow summary counts hidden entries");
  assert(lines[5]?.includes("dispatch_status"), "overflow hint points at dispatch_status");
}

// 7. PI_ENSEMBLE_QUIET_STATUS=1 short-circuits start/update.
{
  reset();
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  startEntry("muted", { label: "developer", role: "developer" });
  updateEntry("muted", makeState("developer", { elapsedMs: 9000 }));
  assert(snapshot().length === 0, "quiet env var prevents entry registration");
  delete process.env.PI_ENSEMBLE_QUIET_STATUS;
  // and now non-quiet works again
  startEntry("audible", { label: "developer", role: "developer" });
  assert(snapshot().length === 1, "deck resumes when env var unset");
}

// 8. formatDeck on empty list returns empty string.
{
  assert(formatDeck([]) === "", "empty list → empty string");
}

// 9. setStatus is called via attached context. Use a fake to capture the call.
{
  reset();
  let lastStatusText: string | undefined | null = null;
  const fakeCtx = {
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        lastStatusText = text;
      },
    },
  } as unknown as Parameters<typeof import("../src/dispatch-deck.ts").attach>[0];
  const deck = await import("../src/dispatch-deck.ts");
  deck.attach(fakeCtx);
  deck.startEntry("only", { label: "developer", role: "developer" });
  deck.updateEntry("only", makeState("developer", { elapsedMs: 4000, lastToolName: "bash" }));

  // setStatus is throttled via setImmediate; await one tick to flush.
  await new Promise((r) => setImmediate(r));
  assert(typeof lastStatusText === "string", "setStatus called with string text");
  assert((lastStatusText ?? "").includes("developer"), "status text includes label");

  deck.clearEntry("only");
  await new Promise((r) => setImmediate(r));
  assert(lastStatusText === undefined, "setStatus called with undefined to clear when empty");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
