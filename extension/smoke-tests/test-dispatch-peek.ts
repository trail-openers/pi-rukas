#!/usr/bin/env bun
/**
 * Pure unit test for dispatch_peek (#21):
 *  - renderPeek with zero in-flight returns the empty hint
 *  - renderPeek with one row shows header + truncated lastText
 *  - renderPeek with many rows shows them in insertion order
 *  - lastText is truncated at 200 chars + newline-flattened
 *  - lastText omitted from output when state has none
 *  - token count rendered when usage > 0
 *
 * The tool's execute() path is exercised indirectly: peek reads
 * dispatchDeck.snapshot(), so we populate the deck and verify render output.
 */

import { type DeckEntry, reset, startEntry, updateEntry } from "../src/dispatch-deck.ts";
import { renderOrchestratorPeek, renderPeek } from "../src/dispatch-peek.ts";
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
  const base = emptyRunningState(role);
  return { ...base, ...opts, usage: { ...base.usage, ...(opts.usage ?? {}) } };
}

// 1. Empty deck — peek returns the empty hint.
{
  reset();
  assert(renderPeek([]).startsWith("no in-flight subagents"), "empty list → empty-hint message");
  assert(renderPeek([]).includes("dispatch_status"), "empty-hint points at dispatch_status");
}

// 2. Single entry — header + last-said line.
{
  const entry: DeckEntry = {
    key: "df8a-2k",
    label: "developer",
    state: makeState("developer", {
      turns: 12,
      toolUses: 14,
      lastToolName: "bash",
      lastText: "Running tests in worktree-A. 47/50 passed; three failing in auth/session.test.ts.",
      elapsedMs: 152000,
      model: "test-model",
      usage: { input: 12000, output: 1500, cacheRead: 800, cacheWrite: 0, cost: 0, turns: 12 },
    }),
  };
  const out = renderPeek([entry]);
  assert(out.startsWith("peek (1 in flight):"), "header counts in-flight");
  assert(out.includes("[df8a-2k]"), "row includes jobId in brackets");
  assert(out.includes("developer"), "row includes label");
  assert(out.includes("12 turns"), "row includes turn count (plural)");
  assert(out.includes("last: bash"), "row includes lastToolName");
  assert(out.includes("2m32s"), "row includes formatted elapsed");
  assert(out.includes("toks"), "row includes token count");
  assert(out.includes("test-model"), "row includes model");
  assert(out.includes('last said: "Running tests'), "row has last-said line on next line");
}

// 3. Plural-aware turn label.
{
  const entry: DeckEntry = {
    key: "x",
    label: "ops",
    state: makeState("ops", { turns: 1, elapsedMs: 1000 }),
  };
  const out = renderPeek([entry]);
  assert(out.includes("1 turn"), "1 turn (singular, no 's')");
  assert(!out.includes("1 turns"), "no 's' when singular");
}

// 4. Multi-entry list preserves insertion (= deck) order.
{
  reset();
  startEntry("a", { label: "developer", role: "developer" });
  startEntry("b", { label: "explore", role: "explore" });
  startEntry("c", { label: "ops", role: "ops" });
  updateEntry("a", makeState("developer", { elapsedMs: 4000, turns: 2 }));
  updateEntry("b", makeState("explore", { elapsedMs: 3000, turns: 1, lastText: "grep results" }));
  updateEntry("c", makeState("ops", { elapsedMs: 2000, turns: 1 }));

  const all = (await import("../src/dispatch-deck.ts")).snapshot();
  const out = renderPeek(all);
  const lines = out.split("\n");
  // header + 3 rows + 1 last-said line (only 'b' has lastText)
  assert(lines[0]?.startsWith("peek (3 in flight):"), "header counts all entries");
  assert(lines[1]?.includes("developer"), "first row is developer (insertion order)");
  assert(lines[2]?.includes("explore"), "second row is explore");
  // third entry has last-said line only for 'b' (explore)
  const expectedLastSaidIdx = lines.findIndex((l) => l.includes("last said"));
  assert(expectedLastSaidIdx === 3, "explore's last-said inserts between its row and the next");
}

// 5. lastText longer than 200 chars is truncated + flattened.
{
  const longText =
    "x".repeat(50) +
    "\n" +
    "y".repeat(50) +
    " z\nw\n" +
    "tail".repeat(40);
  const out = renderPeek([
    {
      key: "k",
      label: "developer",
      state: makeState("developer", { elapsedMs: 1000, lastText: longText, turns: 1 }),
    },
  ]);
  const lastSaidLine = out.split("\n").find((l) => l.includes("last said")) ?? "";
  // Match: '    last said: "' + content + '"'
  const m = lastSaidLine.match(/last said: "(.*)"$/);
  assert(m !== null, "last-said line matches expected shape");
  const inner = m?.[1] ?? "";
  assert(inner.length <= 200, `lastText truncated to ≤200 chars (got ${inner.length})`);
  assert(!inner.includes("\n"), "newlines flattened in lastText");
  assert(inner.endsWith("…"), "ellipsis on truncation");
}

// 6. Entry without lastText skips the last-said line.
{
  const out = renderPeek([
    {
      key: "k",
      label: "ops",
      state: makeState("ops", { elapsedMs: 1000, turns: 1, lastToolName: "gh" }),
    },
  ]);
  assert(!out.includes("last said"), "no last-said line when state has no lastText");
}

// 7. Entry with zero tokens skips the token suffix in the header.
{
  const out = renderPeek([
    {
      key: "k",
      label: "ops",
      state: makeState("ops", { elapsedMs: 1000, turns: 1 }),
    },
  ]);
  assert(!out.includes("toks"), "zero tokens omitted from header");
}

// 8. renderOrchestratorPeek surfaces the active inner child plus the
//    orchestrator's jobId, so PM can tell at a glance "this came from an
//    orchestrator" vs a normal single dispatch.
{
  const entry: DeckEntry = {
    key: "run1/round2-review",
    label: "adversarial-developer[round2-review]",
    state: makeState("adversarial-developer", {
      turns: 4,
      lastToolName: "read",
      lastText: "Reviewing the diff line by line. Found 2 issues so far.",
      elapsedMs: 45000,
    }),
  };
  const out = renderOrchestratorPeek("loop-xyz123", entry);
  assert(out.includes("orchestrator 'loop-xyz123'"), "renderOrchestratorPeek names the orchestrator jobId");
  assert(out.includes("active inner child"), "renderOrchestratorPeek labels the row as the active inner child");
  assert(out.includes("adversarial-developer[round2-review]"), "renderOrchestratorPeek shows the inner child's label");
  assert(out.includes("4 turns"), "renderOrchestratorPeek carries the active child's turn count");
  assert(out.includes('last said: "Reviewing the diff'), "renderOrchestratorPeek includes the active child's last text");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
