#!/usr/bin/env bun
/**
 * #915 lens r1 — per-code-point filtering of pasted / plain multi-char
 * text, and the input's length cap.
 *
 * before: the bracketed-paste branch and the multi-char plain-text branch
 * (deck-key-decode.ts) inserted the (marker-stripped) content with only a
 * newline collapse — C0/C1 controls, DEL and Kitty PUA code points riding
 * in a paste or an IME commit reached the input unvalidated (the single-char
 * and CSI-u paths had the isInsertableCodePoint guard; these two branches
 * did not). And a huge paste could grow the input without bound.
 *
 * after: both branches run `filterPlainText` (insertables in,
 * newlines/CR/tabs → space, everything else dropped, whitespace runs
 * collapsed), and the component caps the input at INPUT_MAX_CHARS
 * (first 8000 chars kept).
 */

import { decodeInsertable } from "../src/deck-key-decode.ts";
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

function makeHeader(): ViewHeader {
  return {
    label: "developer",
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

// ---------------------------------------------------------------------------
// 1. A bracketed paste carrying C0, C1, DEL, PUA and printable code points
//    yields only the printable characters (controls dropped, newlines and
//    tabs collapsed to spaces, whitespace runs collapsed).
// ---------------------------------------------------------------------------
{
  // Carries: C0 (\x07 bell), C1 (\x9b), DEL (\x7f), a Kitty PUA (U+E015),
  // a tab, a form feed and a newline (collapsed to spaces by the filter).
  const paste = "\u001b[200~a\x07b\x9bc\x7fd\x07\ue015é😀e\f\nfg\t h\u001b[201~";
  const out = decodeInsertable(paste);
  assert(out !== undefined, "1a: paste with controls decodes to a string");
  assert(
    out === "abcdé😀e fg h",
    `1b: only printables survive, newlines/tabs → space, runs collapsed (got ${JSON.stringify(out)})`,
  );
  // Nothing control-shaped survives.
  assert(
    out !== undefined &&
      [...out].every((c) => {
        const cp = c.codePointAt(0) ?? 0;
        return (
          cp >= 32 && cp !== 0x7f && !(cp >= 0x80 && cp < 0xa0) && !(cp >= 0xe000 && cp <= 0xf8ff)
        );
      }),
    "1c: no C0/C1/DEL/PUA code point survives the paste filter",
  );
  // The same content via a multi-char plain-text chunk (IME commit /
  // non-bracketed-paste delivery) is filtered identically.
  const plain = "a\x07b\x9bc\x7fd\x07\ue015é😀e\f\nfg\t h";
  const out2 = decodeInsertable(plain);
  assert(
    out2 === "abcdé😀e fg h",
    `1d: plain multi-char chunk filters identically (got ${JSON.stringify(out2)})`,
  );
  // Whitespace-only paste content collapses to a single space.
  assert(
    decodeInsertable("\u001b[200~ \n \t\u001b[201~") === " ",
    "1e: whitespace-only paste collapses to a single space",
  );
  // All-control paste content drops to the empty string (inserts nothing).
  assert(
    decodeInsertable("\u001b[200~\x07\x9b\x7f\u001b[201~") === "",
    "1f: all-control paste drops to empty",
  );
  // 1g: the remaining C0 line-break codes — form feed (\f, 0x0C) and
  // vertical tab (\v, 0x0B) — are dropped, not inserted: they fall through
  // isInsertableCodePoint (cp >= 32 fails) and are not one of the three
  // collapse-to-space codes (0x09/0x0a/0x0d), so the filter drops them.
  // (The fixture literal above stays as-is; this is an independent check.)
  const feedPaste = decodeInsertable("\u001b[200~a\f\vb\u001b[201~");
  assert(
    feedPaste === "ab",
    `1g: form feed (\f) and vertical tab (\v) are dropped, not inserted (got ${JSON.stringify(feedPaste)})`,
  );
  const feedPlain = decodeInsertable("a\f\vb");
  assert(
    feedPlain === "ab",
    `1g2: \f/\v drop identically in a plain multi-char chunk (got ${JSON.stringify(feedPlain)})`,
  );
}

// ---------------------------------------------------------------------------
// 2. The input's length cap: a 20,000-char paste leaves the input at
//    exactly 8,000 characters (the first 8,000 are kept).
// ---------------------------------------------------------------------------
{
  dropBuffer("ivf1");
  startBuffer("ivf1");
  const comp = createAgentViewComponent(
    "ivf1",
    makeHeader,
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  const big = "x".repeat(20000);
  comp.handleInput("\u001b[200~" + big + "\u001b[201~");
  assert(
    comp.inputValue().length === 8000,
    `2a: 20,000-char paste leaves the input at 8,000 chars (got ${comp.inputValue().length})`,
  );
  assert(
    comp.inputValue() === "x".repeat(8000),
    "2b: the first 8,000 chars are kept (tail truncated)",
  );
  // A subsequent insert past the cap truncates the tail of the insert.
  comp.handleInput("yyyy");
  assert(comp.inputValue().length === 8000, "2c: the cap holds after further inserts");
  assert(comp.inputValue().endsWith("xxx"), "2d: the tail of the oversized insert is cut");
  // 2e: an astral surrogate pair straddling the cap boundary (7999 x's +
  // 😀 = 8001 UTF-16 units) must not leave a lone high surrogate at the
  // tail — the slice trims the dangling high surrogate instead (8000 →
  // 7999 x's, the half-cut emoji dropped cleanly).
  dropBuffer("ivf1");
  startBuffer("ivf2");
  const comp2 = createAgentViewComponent(
    "ivf2",
    makeHeader,
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  comp2.handleInput("x".repeat(7999) + "\ud83d\ude00"); // x*7999 + 😀
  assert(
    comp2.inputValue().length === 7999,
    `2e: cap boundary on a surrogate pair trims the dangling high surrogate (got ${comp2.inputValue().length})`,
  );
  assert(comp2.inputValue() === "x".repeat(7999), "2e: the buffer ends on a complete unit");
  dropBuffer("ivf2");
}

// ---------------------------------------------------------------------------
// 3. The inline status line is width-bounded to a SINGLE terminal row (the
//    status text plus the "· Esc back" suffix renders at ≤ width and with no
//    raw newline — toTerminalLine sanitises, collapses newlines to ` ⏎ `,
//    and width-bounds, the same treatment as the input line).
// ---------------------------------------------------------------------------
{
  dropBuffer("ivf3");
  startBuffer("ivf3");
  const comp = createAgentViewComponent(
    "ivf3",
    makeHeader,
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  comp.setStatus({ text: "x".repeat(500), ok: true });
  const lines = comp.render(80);
  const statusLine = lines.find((l) => l.startsWith("xx"));
  assert(
    statusLine !== undefined && statusLine.length <= 80,
    `3a: 500-char status line is width-bounded to 80 (got ${statusLine?.length ?? "missing"})`,
  );
  // 3b: a NEWLINE-BEARING status (the steer catch path feeds err.message,
  // which can be multi-line) must still render as ONE row at ≤ width with
  // no raw newline — the width bound alone does not collapse `\n` (the
  // earlier truncateToWidth-only path overflowed and left a raw newline).
  // The status line is the single non-empty line that is neither the header
  // (index 0) nor the footer (last); the collapsed ` ⏎ ` separator survives
  // truncation, so we locate it by position, not by the (truncated) suffix.
  dropBuffer("ivf3");
  startBuffer("ivf3");
  const comp2 = createAgentViewComponent(
    "ivf3",
    makeHeader,
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  comp2.setStatus({ text: "a\nb".repeat(100), ok: false });
  const lines2 = comp2.render(80);
  const statusLine2 = lines2
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => l.length > 0 && i !== 0 && i !== lines2.length - 1)
    .map(({ l }) => l)[0];
  assert(
    statusLine2 !== undefined && !statusLine2.includes("\n"),
    `3b: newline-bearing status line renders as a single row (got ${statusLine2 !== undefined ? JSON.stringify(statusLine2) : "missing"})`,
  );
  assert(
    statusLine2 !== undefined && statusLine2.length <= 80,
    `3b: newline-bearing status line is width-bounded to 80 (got ${statusLine2?.length ?? "missing"})`,
  );
  // 3c: a SHORT newline-bearing status keeps the "· Esc back" suffix (the
  // common delivered/between-rounds case — short, newline-free or lightly
  // multi-line) and still fits at ≤ width with no raw newline.
  dropBuffer("ivf3");
  startBuffer("ivf3");
  const comp3 = createAgentViewComponent(
    "ivf3",
    makeHeader,
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  comp3.setStatus({ text: "line one\nline two", ok: true });
  const lines3 = comp3.render(80);
  const statusLine3 = lines3.find((l) => l.includes("Esc back"));
  assert(
    statusLine3 !== undefined && !statusLine3.includes("\n"),
    `3c: short multi-line status keeps its suffix on one row (got ${statusLine3 !== undefined ? JSON.stringify(statusLine3) : "missing"})`,
  );
  assert(
    statusLine3 !== undefined && statusLine3.length <= 80,
    `3c: short multi-line status is width-bounded to 80 (got ${statusLine3?.length ?? "missing"})`,
  );
  dropBuffer("ivf3");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
