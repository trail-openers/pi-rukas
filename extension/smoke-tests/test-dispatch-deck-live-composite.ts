#!/usr/bin/env bun
/**
 * Composite-factory hostile-row rendering (extracted verbatim from
 * test-dispatch-deck-live-render.ts section 9 when the parent hit the
 * 500-line file limit). Every Text row of the composite is a single
 * terminal row within the render width for hostile entries.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { buildAgentListLines } from "../src/agent-list.ts";
import { buildCompositeWidgetFactory } from "../src/dispatch-deck-confirm-row.ts";
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
      { key: "main", text: "main", selectable: true },
      {
        key: hostileEntry.key,
        text: `⏳ ${hostileEntry.label} · ${hostileEntry.state.role}`,
        selectable: true,
      },
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

// 10. #914 — the passive widget's agent-list projection must use the RENDER
//     width, not the batch-header ROW cap: a 60-char label at 120 columns
//     must survive the projection intact (the bug cut it to `maxRows` cols).
// ---------------------------------------------------------------------------
{
  const now = 1_000_000_000;
  const longLabel = "a".repeat(60);
  const t0 = Date.now();
  const entry: DeckEntry = {
    key: "job-x",
    label: longLabel,
    seq: 1,
    startedAt: t0 - 60_000,
    state: {
      role: "developer",
      done: false,
      lastToolName: "bash",
      toolUses: 1,
      lastToolHint: "ls",
      lastEventAt: t0 - 1000,
      elapsedMs: 60_000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      totalTokens: 0,
    },
  };
  const maxRows = 5;
  // The projection's `now` matches the widget's (Date.now()), so neither
  // side's STALE-marker decision can differ from the other's.
  const factory = buildCompositeWidgetFactory(
    () => [entry],
    () => [],
    () => undefined,
    () => false,
    maxRows,
  );
  const fakeTheme = {
    fg: (_c: string, t: string) => t,
  } as never;
  const fakeTui = { terminal: { columns: 120 } } as never;
  const comp = factory(fakeTui, fakeTheme);
  const rows: string[] = [];
  for (const child of (comp as { children: unknown[] }).children) {
    const c = child as { render: (w: number) => string[] };
    rows.push(...c.render(120));
  }
  // The job row is the one row that is not the `main` row (the blank
  // separator renders as an empty string and is excluded).
  // The projection is the single source of the row: the full 60-char label
  // must survive the width (118 cols here), and the rendered row must carry
  // the projection's text (the passive widget must use the RENDER width, not
  // the batch-header ROW cap — the bug cut the label to 5 chars).
  const projection = buildAgentListLines([entry], 118);
  const jobLine = projection.find((l) => l.key === "job-x");
  assert(
    !!jobLine && jobLine.text.includes(longLabel),
    "10a: the full 60-char label survives the width-118 projection",
  );
  // The rendered job row (the leading `> ` / `  ` prefix and the `◆ ` main
  // row are the only other non-empty rows) must end with the projection's
  // full text — the bug cut it to `maxRows` (5) characters, which is
  // visible as a missing label here.
  // The Text children pad to the render width, so compare against the
  // row content stripped of trailing padding (the projection text has none).
  // The Text children pad every row to the render width (trailing spaces),
  // so identify the job row on its TRIMMED content (no `◆ ` main prefix, no
  // blank separator).
  const jobRow = rows.find((l) => l.trim() !== "" && !l.trim().startsWith("◆ "))?.trimEnd();
  assert(
    !!jobRow && !!jobLine && jobRow.endsWith(jobLine.text),
    "10b: the widget renders the projection's full text (width, not maxRows)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
