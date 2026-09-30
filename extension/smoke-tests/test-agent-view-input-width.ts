#!/usr/bin/env bun
/**
 * #915 — the input line's terminal width safety.
 *
 * The input line renders as `Message @<label>: <text>▍` (cursor ▍). The
 * width budget must be computed in VISIBLE COLUMNS (pi-tui's visibleWidth),
 * not UTF-16 code units: a CJK label (2 columns/char) or CJK/emoji input
 * (2 columns/char) overflows `width` when the budget counts .length.
 *
 * Checks at widths 20, 40 and 80, with a 40-char CJK label and an input
 * of 100 CJK chars + emoji:
 *   - every rendered line satisfies visibleWidth ≤ width;
 *   - the input line ends with the TAIL of the typed input plus the
 *     cursor (the last typed characters, in order);
 *   - ASCII behaviour is unchanged (a short ASCII input renders in full).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createAgentViewComponent,
  type ViewHeader,
} from "../src/dispatch-deck-live-view-component.ts";
import { dropBuffer, startBuffer } from "../src/dispatch-deck-live.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fakeTheme = { muted: (t: string) => t, error: (t: string) => t };

/** A 40-char CJK label — 80 visible columns, 40 UTF-16 units. */
const cjkLabel = "字".repeat(40);

/** 100 CJK chars + emoji input (202 UTF-16 units, 201 visible cols). */
const cjkInput = "漢".repeat(100) + "\u20ac\u00a9";

function makeHeader(label: string): ViewHeader {
  return {
    label,
    role: "developer",
    status: "running",
    startedAt: Date.now() - 5000,
    now: Date.now(),
    turns: 1,
    totalTokens: 100,
    pmActive: false,
    notices: 0,
    settled: false,
  };
}

const CURSOR = "\u258D";

// ---------------------------------------------------------------------------
// 1. CJK label + CJK/emoji input at widths 20, 40 and 80: every rendered
//    line satisfies visibleWidth ≤ width, and the input line shows the
//    TAIL of the typed input plus the cursor.
// ---------------------------------------------------------------------------
for (const width of [20, 40, 80]) {
  const key = `ivw${width}`;
  dropBuffer(key);
  startBuffer(key);
  const comp = createAgentViewComponent(
    key,
    () => makeHeader(cjkLabel),
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  // Paste the whole input as one chunk (bracketed-paste delivery).
  comp.handleInput(`\u001b[200~${cjkInput}\u001b[201~`);
  const lines = comp.render(width);
  let allFit = true;
  for (let i = 0; i < lines.length; i++) {
    const w = visibleWidth(lines[i] ?? "");
    if (w > width) {
      allFit = false;
      console.error(`    (w=${width} line ${i}: visibleWidth ${w} > ${width})`);
    }
  }
  assert(allFit, `1a(w=${width}): every rendered line has visibleWidth ≤ ${width}`);
  // The input line is the second-to-last line (the footer is last).
  const inputLine = lines[lines.length - 2];
  assert(
    inputLine !== undefined && inputLine.endsWith(CURSOR),
    `1b(w=${width}): input line ends with the cursor (got ${JSON.stringify(inputLine)})`,
  );
  // The tail of the typed input (the last typed characters) is present,
  // in order, just before the cursor: take a short suffix of the input
  // that fits comfortably even at width 20 and require it verbatim.
  // At width 20 the prompt is half-bounded (10 cols of "Message @…") and
  // the budget is 9, so only the final emoji pair (2 cols) can fit; at
  // 40/80 at least 4 CJK chars (8 cols) plus the pair fit. The last CJK
  // chars precede the pair in the input, so "the last typed characters"
  // are present in order in either case.
  const tail = "漢漢漢漢漢漢"; // 6 CJK chars (12 cols) + the emoji pair (2 cols)
  const tailEmoji = "漢漢漢漢\u20ac\u00a9";
  const tailPair = "\u20ac\u00a9";
  assert(
    inputLine !== undefined &&
      (inputLine.endsWith(tail + CURSOR) ||
        inputLine.endsWith(tailEmoji + CURSOR) ||
        inputLine.endsWith(tailPair + CURSOR)),
    `1c(w=${width}): input line ends with the LAST typed characters + cursor`,
  );
  dropBuffer(key);
}

// ---------------------------------------------------------------------------
// 2. ASCII behaviour is unchanged: a short ASCII input renders in full
//    (prompt + full text + cursor) and still fits.
// ---------------------------------------------------------------------------
{
  dropBuffer("ivw-ascii");
  startBuffer("ivw-ascii");
  const comp = createAgentViewComponent(
    "ivw-ascii",
    () => makeHeader("developer"),
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  const ascii = "focus on tests";
  for (const ch of ascii) comp.handleInput(ch);
  const lines = comp.render(80);
  const inputLine = lines[lines.length - 2];
  assert(
    inputLine === `Message @developer: ${ascii}${CURSOR}`,
    `2a: short ASCII input renders in full (got ${JSON.stringify(inputLine)})`,
  );
  assert(
    visibleWidth(inputLine ?? "") <= 80,
    `2b: ASCII input line has visibleWidth ≤ 80 (got ${visibleWidth(inputLine ?? "")})`,
  );
  dropBuffer("ivw-ascii");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
