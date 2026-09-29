#!/usr/bin/env bun
/**
 * Hostile-label rendering invariants for the agent-list overlay (extracted
 * verbatim from test-dispatch-deck-list.ts section 8 when the parent hit
 * the 500-line file limit). Every rendered row is a SINGLE line whose
 * visibleWidth is within the render width — newline, ANSI, 2000 chars
 * and CJK all stay inside the budget.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildAgentListLines,
  createAgentListComponent,
  type AgentListLine,
} from "../src/agent-list.ts";
import type { DeckEntry } from "../src/dispatch-deck.ts";
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

const NOW = 2_000_000;

function mkState(role: string, opts: Partial<RunningState> = {}): RunningState {
  const base = emptyRunningState(role);
  return { ...base, ...opts, usage: { ...base.usage, ...(opts.usage ?? {}) } };
}

interface Harness {
  comp: ReturnType<typeof createAgentListComponent>;
}
function makeHarness(entries: DeckEntry[], width = 80): Harness {
  const h: Harness = { comp: undefined as unknown };
  let rows: AgentListLine[] = [];
  h.comp = createAgentListComponent(
    () => {
      rows = buildAgentListLines(entries, width, NOW);
      return rows;
    },
    () => width,
    () => {},
    () => {},
    () => ({ selected: (t) => t, muted: (t) => t }),
    () => {},
  );
  h.comp.render(width);
  return h;
}

// ---------------------------------------------------------------------------
// 8. Hostile labels (#927 / PR #928): every rendered row is a SINGLE line
//    whose visibleWidth ≤ the render width — newline, ANSI, 2000 chars
//    and CJK all stay inside the budget.
// ---------------------------------------------------------------------------
{
  const hostile = [
    "evil\nlabel",
    "\x1b[31mANSI\x1b[0m label",
    "x".repeat(2000),
    "日本語ラベル",
    "\r\n mixed \u0000 control",
  ];
  const entries: DeckEntry[] = hostile.map((label, i) => ({
    key: `job-h${i}`,
    label,
    state: mkState("developer", {
      lastToolName: `tool\n${"y".repeat(300)}`,
      lastToolHint: `\x1b[99mhint${"z".repeat(300)}`,
    }),
    seq: i,
    startedAt: NOW - 1000 * (i + 1),
  }));
  const lines = buildAgentListLines(entries, 60, NOW);
  let allSingle = true;
  let allBounded = true;
  for (const row of lines) {
    if (row.text.includes("\n") || row.text.includes("\r") || row.text.includes("\u0000"))
      allSingle = false;
    if (visibleWidth(row.text) > 60) allBounded = false;
  }
  assert(allSingle, "8a: no rendered row contains a newline/CR/NUL (single-row invariant)");
  assert(allBounded, "8b: every projected row's visibleWidth ≤ the 60-col budget (CJK/ANSI-safe)");

  const h = makeHarness(entries, []);
  const rendered = h.comp.render(60);
  let compBounded = true;
  for (const r of rendered) if (visibleWidth(r) > 60) compBounded = false;
  assert(compBounded, "8c: component render rows are also within the width budget");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
