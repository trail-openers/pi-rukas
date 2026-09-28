#!/usr/bin/env bun
/**
 * Composite-factory hostile-row rendering (extracted verbatim from
 * test-dispatch-deck-live-render.ts section 9 when the parent hit the
 * 500-line file limit). Every Text row of the composite is a single
 * terminal row within the render width for hostile entries.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { buildCompositeFactory } from "../src/dispatch-deck-composite.ts";
import type { DeckEntry } from "../src/dispatch-deck.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 9. Composite factory (below-editor roster): every Text row is single-row
//    and within width for hostile entries.
// ---------------------------------------------------------------------------
{
  const now = 1_000_000_000;
  const hostileEntry: DeckEntry = {
    key: "bad\x00key",
    label: "hostile\nlabel\twith\x00nulls",
    seq: 1,
    startedAt: now - 134_000,
    state: {
      role: "developer",
      done: false,
      lastToolName: "bash",
      toolUses: 1,
      lastToolHint: "cmd\nwith\tnewlines\x00",
      lastEventAt: now - 1000,
      elapsedMs: 134_000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      totalTokens: 0,
    },
  };
  const fakeTheme2 = {
    fg: (_c: string, t: string) => t,
  } as never;
  const factory = buildCompositeFactory(
    () => ["batch header\nline2\twith\ttabs\x00"],
    () => ({ running: [hostileEntry], selectedKey: undefined, showHint: true }),
    () => [
      { key: "main", text: "main", selectable: true, running: true },
      { key: hostileEntry.key, text: `⏳ ${hostileEntry.label} · ${hostileEntry.state.role}`, selectable: true, running: true },
    ],
    20,
  );
  const fakeTui = { terminal: { columns: 80 } } as never;
  const comp = factory(fakeTui, fakeTheme2);
  const rows: string[] = [];
  for (const child of (comp as { children: unknown[] }).children) {
    const c = child as { render: (w: number) => string[] };
    rows.push(...c.render(80));
  }
  let allSingle = true;
  let allWithin = true;
  for (const line of rows) {
    if (line.includes("\n") || line.includes("\r")) allSingle = false;
    if (visibleWidth(line) > 80) allWithin = false;
  }
  assert(allSingle, "9a: composite rows are single-row (no \\n/\\r)");
  assert(allWithin, "9b: composite rows within 80 cols");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
