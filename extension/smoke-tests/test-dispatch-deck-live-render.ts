#!/usr/bin/env bun
/**
 * #927 — terminal-safe single-row rendering for untrusted content in the
 * dispatch deck (live-view overlay, roster rows, steer prompt).
 *
 * pi-tui's differential renderer requires every string returned by
 * `render(width)` (or stored in a widget Text row) to be ONE terminal row
 * with `visibleWidth` ≤ the column budget. Raw newlines / C0 control chars
 * / ANSI escapes from child tool output desync its line accounting — the
 * overlay ghosted over the main chat and left stale copies in scrollback
 * (issue #927). These tests feed hostile untrusted content (newlines,
 * CRLF, tabs, ANSI, C0, 2 000-char lines, wide CJK/emoji) through the real
 * feed path and the real render path, and assert the invariant at widths
 * 40/80/120:
 *
 *   - no returned line contains \n or \r;
 *   - every returned line has visibleWidth ≤ width (pi-tui's visibleWidth);
 *   - the live-view overlay returns at most 26 rows (header + 24 window +
 *     hint) — documented as the overlay's visible window bound;
 *   - the roster rows and steer prompt respect the same invariants.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildCompositeFactory,
  buildJobRows,
  buildSteerPrompt,
} from "../src/dispatch-deck-composite.ts";
import {
  NEWLINE_SEP,
  collapseToSpaces,
  sanitizeText,
  toTerminalLine,
  toTerminalLines,
} from "../src/dispatch-deck-line.ts";
import {
  createLiveViewComponent,
  dropBuffer,
  feedRawEvent,
  getBuffer,
  startBuffer,
} from "../src/dispatch-deck-live.ts";
import { formatRow } from "../src/dispatch-deck-rows.ts";
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

// ---------------------------------------------------------------------------
// 1. sanitizeText: control chars, ANSI, CR, tabs are gone; text survives.
// ---------------------------------------------------------------------------
{
  const raw = "a\r\nb\tc\x1b[31mred\x1b[0m\x00\x07d\u009be";
  const s = sanitizeText(raw);
  assert(s === "a\nb credde", `1a: normalised (got ${JSON.stringify(s)})`);
  assert(!s.includes("\r") && !s.includes("\t"), "1b: no CR / tab");
  assert(!s.includes("\x1b") && !s.includes("\x00"), "1c: no ESC / NUL");
  assert(!s.includes("\u009b") && !s.includes("\u0007"), "1d: no C1 ESC / BEL");
  assert(s.includes("a"), "1e: plain text preserved");
  assert(s.includes("b c"), "1f: CR→LF, tab→space");
  assert(s.includes("redd"), "1g: text around the ANSI sequence preserved");
}

// ---------------------------------------------------------------------------
// 1b. sanitizeText: OSC terminators and a lone trailing ESC (#927 fix).
// ---------------------------------------------------------------------------
{
  const E = "\u001b";
  // OSC terminated by BEL: the whole sequence is dropped.
  const oscBel = sanitizeText(`pre${E}]0;title\u0007post`);
  assert(oscBel === "prepost", `1b-a: OSC + BEL dropped (got ${JSON.stringify(oscBel)})`);
  // OSC terminated by ST (ESC backslash): the whole sequence is dropped.
  const oscSt = sanitizeText(`pre${E}]0;title${E}\\post`);
  assert(oscSt === "prepost", `1b-b: OSC + ST dropped (got ${JSON.stringify(oscSt)})`);
  // A lone ESC at the end of the string: dropped, text before it kept.
  const loneEsc = sanitizeText("tail" + E);
  assert(loneEsc === "tail", `1b-c: lone trailing ESC dropped (got ${JSON.stringify(loneEsc)})`);
  // C1 OSC: 0x9b followed by `]` must be handled exactly like ESC `]`.
  const c1Osc = sanitizeText("pre\u009b]0;title\u0007post");
  assert(c1Osc === "prepost", `1b-d: C1 OSC dropped (got ${JSON.stringify(c1Osc)})`);
  // Unterminated OSC: 10 000-char payload, no terminator — bounded scan.
  const t0 = Date.now(); const unterminated = sanitizeText(`pre${E}]${"x".repeat(10000)}post`);
  assert(!/[\u0000-\u001f\u007f-\u009f]/.test(unterminated), "1b-e: no control chars");
  assert(unterminated.startsWith("pre") && unterminated.endsWith("post"), "1b-f: text preserved");
  assert(Date.now() - t0 < 2000, "1b-g: bounded scan");
}

// ---------------------------------------------------------------------------
// 2. toTerminalLine: no newlines, width-bounded, visible separator.
// ---------------------------------------------------------------------------
{
  const t = toTerminalLine("line1\nline2\r\nline3", 40);
  assert(!t.includes("\n") && !t.includes("\r"), "2a: single row");
  assert(visibleWidth(t) <= 40, "2b: width-bounded");
  assert(
    t.includes("line1") && t.includes("line2") && t.includes("line3"),
    "2c: content preserved",
  );
  assert(t.includes(NEWLINE_SEP), "2d: newlines become the visible separator");
  assert(visibleWidth(toTerminalLine("x".repeat(500), 40)) <= 40, "2e: 500-char row → ≤40");
  assert(toTerminalLine("x".repeat(500), 40).includes("…"), "2f: ellipsis on overflow");
  assert(visibleWidth(toTerminalLine("x".repeat(500), 0)) <= 0, "2g: width 0 → empty");
}

// ---------------------------------------------------------------------------
// 3. toTerminalLines: each row individually width-bounded.
// ---------------------------------------------------------------------------
{
  const rows = toTerminalLines(`a\nb\n${"c".repeat(500)}`, 10);
  assert(rows.length === 3, `3a: three rows (got ${rows.length})`);
  for (const r of rows) {
    assert(!r.includes("\n"), "3b: no newlines in any row");
    assert(visibleWidth(r) <= 10, "3c: each row ≤ width");
  }
}

// ---------------------------------------------------------------------------
// 4. collapseToSpaces: one line, whitespace-normalised, sanitised.
// ---------------------------------------------------------------------------
{
  const c = collapseToSpaces("a\n\n  b\tc\x1b[31m");
  assert(c === "a b c", `4a: collapsed + sanitised (got ${JSON.stringify(c)})`);
}

// ---------------------------------------------------------------------------
// 5. Live-view overlay: hostile events → every render row is one row,
//    visibleWidth ≤ width, and the overlay is bounded to 26 rows.
// ---------------------------------------------------------------------------
const fakeTheme = { muted: (t: string) => t, error: (t: string) => t } as const;
const HOSTILE_TEXT =
  '✓ bash {\n  "results": [\n    {"field": "value"}\n  ]\n}\nAvailable fields:\nassignees\n\u009b[31mANSI\u0007\x00tab\there';
const HOSTILE_RESULT = "line1\r\nline2\tline3\u009b[31mred\u0007\x00end";
const HOSTILE_ARGS = "command\nwith\tnewlines\u009b[0m";
const HOSTILE_CJK = "日本語のテキストが長く続く場合".repeat(30); // wide chars
const HOSTILE_EMOJI = "😀🚀🎉👨‍👩‍👧‍👦".repeat(50); // wide + ZWJ sequences

function feedHostile(key: string): void {
  startBuffer(key);
  // assistant text with hostile content
  feedRawEvent(key, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: HOSTILE_TEXT }] },
  });
  // toolCall with hostile args
  feedRawEvent(key, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: HOSTILE_ARGS } }],
    },
  });
  // toolResult with hostile content
  feedRawEvent(key, {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: HOSTILE_RESULT }],
    },
  });
  // a very wide CJK line
  feedRawEvent(key, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: HOSTILE_CJK }] },
  });
  // a very wide emoji line
  feedRawEvent(key, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: HOSTILE_EMOJI }] },
  });
  // a 2000-char single line
  feedRawEvent(key, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2000) }] },
  });
  // a hostile tool name
  feedRawEvent(key, {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "bad\x00name\r\nhere",
      content: [{ type: "text", text: "result" }],
    },
  });
}

for (const w of [40, 80, 120]) {
  const key = `lv-w${w}`;
  dropBuffer(key);
  feedHostile(key);
  const comp = createLiveViewComponent(
    key,
    () => ({
      label: "label-with\nnewline\tand\x00null",
      role: "developer",
      startedAt: Date.now(),
      now: Date.now(),
      turns: 1,
      toolUses: 1,
      totalTokens: 100,
      lastToolName: "bash",
    }),
    fakeTheme,
    () => {},
  );
  const lines = comp.render(w);
  // 26-row bound: header(1) + window(24) + hint(1)
  assert(lines.length <= 26, `5a-w${w}: overlay ≤ 26 rows (got ${lines.length})`);
  let allSingle = true;
  let allWithin = true;
  for (const line of lines) {
    if (line.includes("\n") || line.includes("\r")) allSingle = false;
    if (visibleWidth(line) > w) allWithin = false;
  }
  assert(allSingle, `5b-w${w}: every returned line is a single row (no \\n/\\r)`);
  assert(allWithin, `5c-w${w}: every returned line has visibleWidth ≤ ${w}`);
  dropBuffer(key);
}

// ---------------------------------------------------------------------------
// 6. 200 mixed multi-line events → render ≤ 26 rows at all widths.
// ---------------------------------------------------------------------------
for (const w of [40, 80, 120]) {
  const key = `lv-200-w${w}`;
  dropBuffer(key);
  startBuffer(key);
  for (let i = 0; i < 200; i++) {
    const kind = i % 3;
    if (kind === 0) {
      feedRawEvent(key, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `text-${i}\nline2\r\nline3\ttabbed` }],
        },
      });
    } else if (kind === 1) {
      feedRawEvent(key, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { command: `cmd-${i}\narg` } }],
        },
      });
    } else {
      feedRawEvent(key, {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: `res-${i}\r\nout2\x00` }],
        },
      });
    }
  }
  const comp = createLiveViewComponent(
    key,
    () => undefined,
    fakeTheme,
    () => {},
  );
  const lines = comp.render(w);
  assert(
    lines.length <= 26,
    `6a-w${w}: 200 mixed multi-line events → ≤ 26 rows (got ${lines.length})`,
  );
  let allSingle = true;
  let allWithin = true;
  for (const line of lines) {
    if (line.includes("\n") || line.includes("\r")) allSingle = false;
    if (visibleWidth(line) > w) allWithin = false;
  }
  assert(allSingle, `6b-w${w}: no \\n/\\r in any of 200-event render rows`);
  assert(allWithin, `6c-w${w}: all 200-event render rows within width`);
  dropBuffer(key);
}

// ---------------------------------------------------------------------------
// 7. Feed-time normalisation: the ring buffer stores already-sanitised,
//    single-logical-line events (the overlay reads them verbatim).
// ---------------------------------------------------------------------------
{
  const key = "feed-normalise";
  dropBuffer(key);
  startBuffer(key);
  feedRawEvent(key, {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "a\r\nb\tc\x1b[31md\x00e" }],
    },
  });
  feedRawEvent(key, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x\ny\tz\u009b" }] },
  });
  const buf = getBuffer(key);
  assert(buf.length === 2, "7a: two events buffered");
  const res = buf[0];
  if (res?.kind === "toolResult") {
    assert(
      !res.text.includes("\n") &&
        !res.text.includes("\r") &&
        !res.text.includes("\x1b") &&
        !res.text.includes("\x00"),
      "7b: toolResult text sanitised at feed time",
    );
    assert(
      res.text.includes(NEWLINE_SEP),
      "7c: toolResult newlines → visible separator at feed time",
    );
    assert(res.text.includes("a"), "7d: toolResult content preserved");
  } else {
    assert(false, "7b: expected toolResult event");
  }
  const txt = buf[1];
  if (txt?.kind === "text") {
    assert(
      !txt.text.includes("\n") && !txt.text.includes("\x1b"),
      "7e: assistant text sanitised at feed time",
    );
    assert(
      txt.text.includes(NEWLINE_SEP),
      "7f: assistant newlines → visible separator at feed time",
    );
  } else {
    assert(false, "7e: expected text event");
  }
  dropBuffer(key);
}

// ---------------------------------------------------------------------------
// 8. Roster rows (formatRow + buildJobRows): hostile label/hint/key →
//    single-row, width-bounded.
// ---------------------------------------------------------------------------
{
  const now = 1_000_000_000;
  const hostileEntry: DeckEntry = {
    key: "bad\x00key\r\nline",
    label: "hostile\nlabel\twith\x00nulls",
    seq: 1,
    startedAt: now - 134_000,
    state: {
      role: "developer",
      tag: "ux\nweb",
      done: false,
      lastToolName: "bash",
      toolUses: 2,
      lastToolHint: "cmd\nwith\tnewlines\x00",
      lastEventAt: now - 1000,
      elapsedMs: 134_000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      totalTokens: 0,
    },
  };
  const row = formatRow(hostileEntry, now);
  assert(
    !row.includes("\n") && !row.includes("\r"),
    "8a: formatRow is a single row (label/hint sanitised)",
  );
  assert(visibleWidth(row) <= 120, `8b: formatRow within 120 cols (got ${visibleWidth(row)})`);
  assert(row.includes("hostile"), "8c: label content preserved");

  // buildJobRows with a width bound (the composite's render path).
  const entries = [
    {
      key: "aaaaaaaaaaa1",
      label: "developer",
      seq: 0,
      startedAt: now - 134_000,
      state: {
        role: "developer",
        done: false,
        lastEventAt: now - 1000,
        elapsedMs: 134_000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        totalTokens: 0,
      },
    },
    {
      key: "aaaaaaaaaaa2",
      label: "developer",
      seq: 1,
      startedAt: now - 134_000,
      state: {
        role: "developer",
        done: false,
        lastEventAt: now - 1000,
        elapsedMs: 134_000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        totalTokens: 0,
      },
    },
  ];
  const rows = buildJobRows(entries, now, 80);
  assert(rows.length === 2, "8d: two job rows");
  for (const r of rows) {
    assert(!r.text.includes("\n") && !r.text.includes("\r"), "8e: buildJobRows row is single-row");
    assert(visibleWidth(r.text) <= 80, "8f: buildJobRows row within width");
  }
  assert(rows[0]?.text !== rows[1]?.text, "8g: rows remain distinct after sanitisation");
}

// ---------------------------------------------------------------------------
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

{
  const now = 1_000_000_000;
  const hostileEntry: DeckEntry = {
    key: "bad\x00key\r\nline",
    label: "hostile\nlabel\twith\x00nulls",
    seq: 1,
    startedAt: now - 134_000,
    state: {
      role: "developer",
      done: false,
      lastToolName: "bash",
      lastEventAt: now - 1000,
      elapsedMs: 134_000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      totalTokens: 0,
    },
  };
  const prompt = buildSteerPrompt(hostileEntry, now);
  const promptLines = prompt.split("\n");
  assert(
    promptLines.length === 2,
    `10a: steer prompt is exactly two lines (got ${promptLines.length})`,
  );
  assert(promptLines[0]?.includes("[deck-ui steer →"), "10b: structural prefix preserved");
  assert(promptLines[0]?.includes("job "), "10c: job-key line preserved");
  assert(
    !promptLines[0]?.includes("\x00") && !promptLines[0]?.includes("\t"),
    "10d: label/key sanitised (no control chars/tabs)",
  );
  assert(
    promptLines[1]?.startsWith("Reply with a short status update"),
    "10e: second line structure preserved",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
