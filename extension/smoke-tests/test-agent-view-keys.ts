#!/usr/bin/env bun
/**
 * #915 — the agent view input's key-protocol handling (deck-key-decode.ts
 * and the component's handleInput fallback branch).
 *
 * before: this file did not exist — the input's printable-key detection
 * was a single-char branch (ASCII 32–126) plus a multi-char paste
 * fallback that inserted raw multi-char data as-is. On a Kitty-protocol
 * terminal (the default in every modern terminal — pi-tui's
 * ProcessTerminal auto-negotiates) a plain "a" arrives as \x1b[97u and
 * the raw 5-char escape sequence would have been inserted into the
 * buffer; F-keys, arrows and mouse sequences would have inserted the
 * same garbage. The new decode module (deck-key-decode.ts) routes
 * every non-command key through decodeInsertable; this file proves the
 * decision table: printables (including non-ASCII and kitty CSI-u)
 * insert, unknown escape sequences swallow, pastes collapse newlines,
 * and key-releases are ignored.
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

function makeHeader(over: Partial<ViewHeader> = {}): ViewHeader {
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
    ...over,
  };
}

function makeComp(key: string, sent: string[], done: (r: string) => void = () => {}) {
  const comp = createAgentViewComponent(key, () => makeHeader(), fakeTheme, undefined, done, (t) =>
    sent.push(t),
  );
  return comp;
}

// ---------------------------------------------------------------------------
// 1. decodeInsertable decision table — printables insert, unknown escape
//    sequences swallow, pastes collapse newlines, releases ignore.
// ---------------------------------------------------------------------------
{
  // Printable ASCII, single char.
  assert(decodeInsertable("a") === "a", "1a: 'a' inserts");
  assert(decodeInsertable(" ") === " ", "1b: space inserts");
  assert(decodeInsertable("9") === "9", "1c: digit inserts");
  // Kitty CSI-u printable: well-formed and shifted.
  assert(decodeInsertable("\u001b[97u") === "a", "1d: kitty CSI-u 'a' (\u001b[97u) inserts the character");
  assert(decodeInsertable("\u001b[97;2u") === "a", "1e: kitty shifted 'A' (\u001b[97;2u) inserts");
  // Non-ASCII via CSI-u (code points 128+): the strict decoder's
  // primary-matching path — the character that was decoded is inserted,
  // whatever it is (the buffer stores the decoded character; the
  // important invariant is that NO raw escape sequence reaches it).
  const eacute = decodeInsertable("\u001b[1101u");
  assert(
    eacute !== undefined && eacute.length > 0 && [...eacute].every((c) => (c.codePointAt(0) ?? 0) >= 32),
    "1f: kitty non-ASCII CSI-u inserts a printable character (not a raw sequence)",
  );
  // Malformed CSI-u (numeric prefix is not the pressed key's code point):
  // pi-tui's strict decoder reads the alternate-key group and returns a
  // spurious single character. The trade is documented in
  // deck-key-decode.ts — a spurious char beats raw garbage in the buffer.
  const malformed = decodeInsertable("\u001b[101u");
  assert(
    malformed !== undefined && [...malformed].every((c) => (c.codePointAt(0) ?? 0) >= 32),
    "1g: malformed CSI-u (\u001b[101u) decodes to a printable char, never a raw sequence",
  );
  // Unknown escape sequences: F-keys, mouse SGR, alt-modified, arrow
  // keys, lone ESC, control bytes, the paste end marker — all swallow.
  assert(decodeInsertable("\u001b[57357u") === undefined, "1h: kitty F1 swallows");
  assert(decodeInsertable("\u001b[57359u") === undefined, "1i: kitty up swallows");
  assert(decodeInsertable("\u001b[<0;5;7M") === undefined, "1j: mouse press (SGR) swallows");
  assert(decodeInsertable("\u001b[<0;5;7m") === undefined, "1k: mouse release (SGR) swallows");
  assert(decodeInsertable("\u001b[133;1u") === undefined, "1l: alt-modified CSI-u swallows");
  assert(decodeInsertable("\u001b[A") === undefined, "1m: legacy arrow sequence swallows");
  assert(decodeInsertable("\u001b[11~") === undefined, "1n: legacy F1 swallows");
  assert(decodeInsertable("\u001b[201~") === undefined, "1o: bracketed-paste end marker swallows");
  assert(decodeInsertable("\u001b") === undefined, "1p: lone ESC swallows");
  assert(decodeInsertable("\x01") === undefined, "1q: control byte swallows");
  assert(decodeInsertable("\x7f") === undefined, "1r: DEL swallows (component handles it as backspace)");
  // Paste / IME: newlines collapse to spaces.
  assert(decodeInsertable("hello") === "hello", "1s: multi-char text inserts");
  assert(decodeInsertable("a\nb") === "a b", "1t: newline collapses to a space");
  assert(decodeInsertable("\u001b[200~abc\u001b[201~") === "abc", "1u: bracketed paste strips the markers");
  assert(
    decodeInsertable("\u001b[200~a\nb\u001b[201~") === "a b",
    "1v: bracketed paste with newlines collapses them",
  );
  // Empty input.
  assert(decodeInsertable("") === undefined, "1w: empty data swallows");
}

// ---------------------------------------------------------------------------
// 2. The component's handleInput: kitty CSI-u letters insert (not raw
//    sequences), unknown sequences insert nothing, a paste with newlines
//    collapses, and a key-release inserts nothing.
// ---------------------------------------------------------------------------
{
  dropBuffer("kv1");
  startBuffer("kv1");
  const comp = makeComp("kv1", []);
  // Kitty CSI-u letter: 'a' arrives as \u001b[97u — the decoded character
  // inserts, not the raw 5-char sequence.
  comp.handleInput("\u001b[97u");
  assert(comp.inputValue() === "a", `2a: kitty CSI-u 'a' inserts the character (got ${JSON.stringify(comp.inputValue())})`);
  // Legacy letter alongside: both coexist.
  comp.handleInput("b");
  assert(comp.inputValue() === "ab", "2b: legacy 'b' inserts after the CSI-u char");
  // Unknown escape sequences (kitty F1, mouse, alt+x): swallowed.
  const before = comp.inputValue();
  comp.handleInput("\u001b[57357u"); // kitty F1
  comp.handleInput("\u001b[<0;5;7M"); // mouse press
  comp.handleInput("\u001b[133;1u"); // alt-modified CSI-u
  assert(comp.inputValue() === before, `2c: unknown escape sequences insert nothing (got ${JSON.stringify(comp.inputValue())})`);
  // Paste with newlines: collapses to spaces.
  comp.handleInput("\u001b[200~line one\nline two\u001b[201~");
  assert(
    comp.inputValue() === "abline one line two",
    `2d: bracketed paste with newlines collapses (got ${JSON.stringify(comp.inputValue())})`,
  );
  // Key-release: the isKeyRelease guard at the top of handleInput filters
  // it — the buffer is untouched.
  const before2 = comp.inputValue();
  comp.handleInput("\u001b[97;1:3u"); // kitty key-release for 'a'
  assert(comp.inputValue() === before2, "2e: key-release inserts nothing");
  dropBuffer("kv1");
}

// ---------------------------------------------------------------------------
// 3. Enter: empty input is a no-op (nothing sent); a double-Enter fires
//    the send callback exactly once (the buffer clears before the async
//    callback, so the second Enter finds an empty buffer).
// ---------------------------------------------------------------------------
{
  dropBuffer("kv2");
  startBuffer("kv2");
  // 3a: Enter on an empty input sends nothing.
  const sentEmpty: string[] = [];
  const compEmpty = createAgentViewComponent("kv2", () => makeHeader(), fakeTheme, undefined, () => {}, (t) =>
    sentEmpty.push(t),
  );
  compEmpty.handleInput("\r");
  assert(sentEmpty.length === 0, "3a: Enter on empty input sends nothing");
  // 3b: double-Enter → exactly one send of the typed text.
  const sent: string[] = [];
  const comp2 = createAgentViewComponent("kv2", () => makeHeader(), fakeTheme, undefined, () => {}, (t) =>
    sent.push(t),
  );
  for (const ch of "hi") comp2.handleInput(ch);
  comp2.handleInput("\r");
  comp2.handleInput("\r"); // double-Enter
  assert(sent.length === 1, `3b: double-Enter sends exactly once (got ${sent.length})`);
  assert(sent[0] === "hi", "3c: the single send carries the typed text");
  dropBuffer("kv2");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
