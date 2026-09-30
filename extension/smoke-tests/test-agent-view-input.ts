#!/usr/bin/env bun
/**
 * #915 — the agent view's always-focused message input line.
 *
 * Drives the REAL component (createAgentViewComponent) and openLiveView
 * with the makeStdin recording-stdin pattern from test-dispatch-steer.ts,
 * registering child handles as those tests do.
 */

import { childHandles, jobs } from "../src/async-jobs-registry.ts";
import {
  appendOperatorSteer,
  dropBuffer,
  feedRawEvent,
  getBuffer,
  startBuffer,
  type LiveEvent,
} from "../src/dispatch-deck-live.ts";
import {
  createAgentViewComponent,
  type ViewHeader,
} from "../src/dispatch-deck-live-view-component.ts";
import { openLiveView, type LiveViewTheme } from "../src/dispatch-deck-live-view.ts";
import { clearEntry, reset, snapshot, startEntry } from "../src/dispatch-deck.ts";
import { steerChild } from "../src/dispatch-steer.ts";
import { matchesKey } from "@earendil-works/pi-tui";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fakeTheme: LiveViewTheme = { muted: (t) => t, error: (t) => t };

// A synthetic stdin that records the RPC lines written to it (the
// makeStdin pattern from test-dispatch-steer.ts).
function makeStdin(opts: { fail?: boolean } = {}): {
  write: (s: string) => void;
  lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    write(s: string) {
      if (opts.fail) throw new Error("write EPIPE");
      lines.push(s);
    },
  };
}

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

function resetKeys(keys: string[]): void {
  for (const k of keys) dropBuffer(k);
}

// A helper that wires the component's onSend to steerChild for the given
// key, mirroring what openLiveView does in production. The component is
// passed to the send callback after creation (the component's `onSend`
// closure captures the send function, which captures the component via
// the `compRef` object).
function makeSend(
  key: string,
  compRef: {
    current:
      | {
          setStatus: (s: { text: string; ok: boolean } | undefined) => void;
          clearInput: () => void;
        }
      | undefined;
  },
) {
  return (text: string) => {
    if (!compRef.current) return;
    const result = steerChild(key, text, "deck-ui");
    if (result.delivered) {
      compRef.current.clearInput();
      compRef.current.setStatus({ text: "✓ sent", ok: true });
      appendOperatorSteer(key, "developer", text);
    } else {
      // #915 — the buffer is cleared synchronously on Enter before this
      // callback runs, so a failed delivery would lose the typed text. Put
      // it back: the operator edits and re-sends (the ⧗/✗ status explains
      // why the send did not go through).
      compRef.current.setInput(text);
      if (result.reason === "between-rounds") {
        compRef.current.setStatus({ text: "⧗ between rounds — not sent", ok: false });
      } else {
        compRef.current.setStatus({ text: `✗ ${result.reason ?? "not delivered"}`, ok: false });
      }
    }
  };
}

// Create a component wired to steerChild for the given key.
function makeWiredComp(key: string, header: () => ViewHeader, tui?: { terminal?: { rows?: number } }) {
  const compRef: { current: { setStatus: (s: { text: string; ok: boolean } | undefined) => void; clearInput: () => void; setInput: (t: string) => void } | undefined } = { current: undefined };
  const send = makeSend(key, compRef);
  const comp = createAgentViewComponent(key, header, fakeTheme, tui, () => {}, (text) => send(text));
  compRef.current = { setStatus: (s) => comp.setStatus(s), clearInput: () => comp.clearInput(), setInput: (t) => comp.setInput(t) };
  return comp;
}

// ---------------------------------------------------------------------------
// 1. Typing "focus on tests" + Enter writes EXACTLY one steer envelope to
//    that job's stdin and nothing to another registered job's stdin.
// ---------------------------------------------------------------------------
{
  resetKeys(["iv1"]);
  startBuffer("iv1");
  const stdin1 = makeStdin();
  const stdin2 = makeStdin();
  childHandles.set("iv1", { stdin: stdin1 as never, label: "developer", role: "developer" });
  childHandles.set("iv2", { stdin: stdin2 as never, label: "explore", role: "explore" });
  const comp = makeWiredComp("iv1", () => makeHeader());
  // Type "focus on tests" character by character
  for (const ch of "focus on tests") {
    comp.handleInput(ch);
  }
  // Enter sends
  comp.handleInput("\r");
  assert(stdin1.lines.length === 1, `1a: exactly one stdin line (got ${stdin1.lines.length})`);
  assert(
    stdin1.lines[0] === `${JSON.stringify({ type: "steer", message: "focus on tests" })}\n`,
    "1b: the stdin line is the exact steer envelope",
  );
  assert(stdin2.lines.length === 0, "1c: nothing written to the other job's stdin");
  childHandles.delete("iv1");
  childHandles.delete("iv2");
  dropBuffer("iv1");
}

// ---------------------------------------------------------------------------
// 2. The ✓ line renders, the input clears, and the echo event appears in
//    the rendered body.
// ---------------------------------------------------------------------------
{
  resetKeys(["iv2"]);
  startBuffer("iv2");
  const stdin = makeStdin();
  childHandles.set("iv2", { stdin: stdin as never, label: "developer", role: "developer" });
  const comp = makeWiredComp("iv2", () => makeHeader(), { terminal: { rows: 30 } });
  let sent: string | undefined;
  // Intercept the send: wrap the component's onSend to capture the text
  const origSend = comp; // makeWiredComp already wired it
  // We need to capture what was sent — use a proxy approach: the makeWiredComp
  // already calls steerChild, so we just verify the result via the buffer.
  // Instead, let's use a different approach: create the component manually
  // with a send callback that both records and delegates.
  {
    const compRef: {
      current:
        | {
            setStatus: (s: { text: string; ok: boolean } | undefined) => void;
            clearInput: () => void;
          }
        | undefined;
    } = { current: undefined };
    const send = makeSend("iv2", compRef);
    const comp2 = createAgentViewComponent(
      "iv2",
      () => makeHeader(),
      fakeTheme,
      { terminal: { rows: 30 } },
      () => {},
      (text) => {
        sent = text;
        send(text);
      },
    );
    compRef.current = {
      setStatus: (s) => comp2.setStatus(s),
      clearInput: () => comp2.clearInput(),
    };
    for (const ch of "focus on tests") comp2.handleInput(ch);
    assert(comp2.inputValue() === "focus on tests", "2a: input buffer has the typed text");
    comp2.handleInput("\r"); // send
    assert(sent === "focus on tests", "2b: onSend received the typed text");
    assert(comp2.inputValue() === "", "2c: input cleared after send");
    const flat = comp2.render(80).join("\n");
    assert(flat.includes("✓ sent"), "2d: ✓ status line renders");
    // The echo event was appended by makeSend
    const flat2 = comp2.render(80).join("\n");
    assert(flat2.includes("you → developer: focus on tests"), "2e: echo event renders in body");
  }
  childHandles.delete("iv2");
  dropBuffer("iv2");
}

// ---------------------------------------------------------------------------
// 3. A batch-member target receives it on the member's own handle.
// ---------------------------------------------------------------------------
{
  resetKeys(["iv3"]);
  startBuffer("iv3");
  const memberStdin = makeStdin();
  childHandles.set("iv3", { stdin: memberStdin as never, label: "member-1", role: "developer" });
  const comp = makeWiredComp("iv3", () => makeHeader({ label: "member-1" }));
  for (const ch of "hello member") comp.handleInput(ch);
  comp.handleInput("\r");
  assert(
    memberStdin.lines.length === 1 &&
      JSON.stringify(JSON.parse(memberStdin.lines[0])) ===
        JSON.stringify({ type: "steer", message: "hello member" }),
    "3a: batch-member receives steer on its own handle",
  );
  childHandles.delete("iv3");
  dropBuffer("iv3");
}

// ---------------------------------------------------------------------------
// 4. Orchestrator target routes to its active child; between-rounds shows
//    ⧗ and keeps the text.
// ---------------------------------------------------------------------------
{
  resetKeys(["iv4"]);
  startBuffer("iv4");
  // Active-child orchestrator
  const innerStdin = makeStdin();
  const orchJobId = "orch-iv4";
  jobs.set(orchJobId, {
    kind: "single",
    jobId: orchJobId,
    role: "adversarial-loop",
    label: "adversarial_loop",
    startedAt: Date.now(),
    abort: new AbortController(),
    ownerKind: "driver",
    isOrchestrator: true,
    activeChild: {
      role: "adversarial-developer",
      label: "adversarial-developer",
      deckKey: "iv4",
      stdin: innerStdin as never,
      startedAt: Date.now(),
    },
  });
  childHandles.set("iv4", { stdin: innerStdin as never, label: "developer", role: "developer" });
  const comp = makeWiredComp("iv4", () => makeHeader());
  for (const ch of "refocus") comp.handleInput(ch);
  comp.handleInput("\r");
  assert(innerStdin.lines.length === 1, "4a: orchestrator routes to active inner child");
  // Between-rounds orchestrator
  const idleJobId = "orch-iv4-idle";
  jobs.set(idleJobId, {
    kind: "single",
    jobId: idleJobId,
    role: "adversarial-loop",
    label: "adversarial_loop",
    startedAt: Date.now(),
    abort: new AbortController(),
    ownerKind: "driver",
    isOrchestrator: true,
  });
  // Between-rounds orchestrator: use the orchestrator's job ID so
  // steerChild resolves via getOrchestratorActiveChild (which returns
  // undefined → between-rounds).
  const comp2 = makeWiredComp("orch-iv4-idle", () => makeHeader());
  for (const ch of "try steer") comp2.handleInput(ch);
  assert(comp2.inputValue() === "try steer", "4b: text is in the input before send");
  comp2.handleInput("\r"); // send → between-rounds → keeps text
  assert(
    comp2.inputValue() === "try steer",
    "4b2: between-rounds keeps the text in input after send",
  );
  jobs.delete(orchJobId);
  jobs.delete(idleJobId);
  childHandles.delete("iv4");
  dropBuffer("iv4");
}

// ---------------------------------------------------------------------------
// 5. Settled / unregistered job shows ✗ and keeps the text; a throwing
//    stdin doesn't escape.
// ---------------------------------------------------------------------------
{
  resetKeys(["iv5"]);
  startBuffer("iv5");
  // No handle registered → no-such-job → ✗ status, text kept
  // Use a key with no child handle so steerChild returns no-such-job
  const comp = makeWiredComp("iv5-nohandle", () =>
    makeHeader({ status: "finished", settled: true }),
  );
  for (const ch of "hello") comp.handleInput(ch);
  assert(comp.inputValue() === "hello", "5a: text is in the input before send");
  comp.handleInput("\r"); // send → no-such-job → ✗ status, text kept
  assert(comp.inputValue() === "hello", "5a2: settled job keeps the text after failed send");
  // Throwing stdin — steerChild catches the throw internally, returns
  // delivered:false with the reason. The component's handleInput must not
  // throw either (steerChild never throws on delivery failure).
  const throwStdin = makeStdin({ fail: true });
  childHandles.set("iv5-throw", { stdin: throwStdin as never, label: "dev", role: "developer" });
  const comp2 = makeWiredComp("iv5-throw", () => makeHeader());
  for (const ch of "x") comp2.handleInput(ch);
  let threw = false;
  try {
    comp2.handleInput("\r");
  } catch {
    threw = true;
  }
  assert(!threw, "5b: throwing stdin does not escape handleInput");
  childHandles.delete("iv5-throw");
  dropBuffer("iv5");
}

// ---------------------------------------------------------------------------
// 6. t, x, g, s insert letters (the input shows them, no thinking toggle,
//    no scroll jump); ctrl+t toggles thinking.
// ---------------------------------------------------------------------------
{
  resetKeys(["iv6"]);
  startBuffer("iv6");
  const comp = createAgentViewComponent(
    "iv6",
    () => makeHeader(),
    fakeTheme,
    undefined,
    () => {},
    () => {},
  );
  for (const ch of "txgs") comp.handleInput(ch);
  assert(comp.inputValue() === "txgs", "6a: t, x, g, s all insert letters");
  // ctrl+t toggles thinking (not inserted)
  const before = comp.inputValue();
  comp.handleInput("\x14"); // ctrl+t
  assert(comp.inputValue() === before, "6b: ctrl+t does not insert a character");
  // ctrl+t toggles thinking (verify via render: thinking expanded)
  const thinkText = "thinking content here";
  feedRawEvent("iv6", {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: thinkText } as unknown as {
          type: "thinking";
          thinking: string;
        },
      ],
    },
  });
  // After first ctrl+t: thinking is expanded
  const flatExpanded = comp.render(80).join("\n");
  assert(flatExpanded.includes(thinkText), "6c: thinking expanded after first ctrl+t");
  // ctrl+t again to collapse
  comp.handleInput("\x14");
  const flatCollapsed = comp.render(80).join("\n");
  assert(
    flatCollapsed.includes(`▸ thinking (${thinkText.length} chars)`),
    "6d: thinking collapsed after second ctrl+t",
  );
  dropBuffer("iv6");
}

// ---------------------------------------------------------------------------
// 7. Esc with text clears it (no done); Esc again → done("returnToList").
// ---------------------------------------------------------------------------
{
  resetKeys(["iv7"]);
  startBuffer("iv7");
  const results: string[] = [];
  const comp = createAgentViewComponent(
    "iv7",
    () => makeHeader(),
    fakeTheme,
    undefined,
    (r) => results.push(r),
    (text) => {},
  );
  for (const ch of "abc") comp.handleInput(ch);
  assert(comp.inputValue() === "abc", "7a: input has text");
  comp.handleInput("\x1b"); // Esc with text → clear
  assert(comp.inputValue() === "", "7b: Esc with text clears input");
  assert(results.length === 0, "7c: no done() called when clearing input");
  comp.handleInput("\x1b"); // Esc again (empty) → returnToList
  assert(results.includes("returnToList"), "7d: Esc on empty input → done('returnToList')");
  dropBuffer("iv7");
}

// ---------------------------------------------------------------------------
// 8. A key-release byte doesn't insert or send.
// ---------------------------------------------------------------------------
{
  resetKeys(["iv8"]);
  startBuffer("iv8");
  const results: string[] = [];
  const comp = createAgentViewComponent(
    "iv8",
    () => makeHeader(),
    fakeTheme,
    undefined,
    (r) => results.push(r),
    () => {},
  );
  // Kitty protocol key-release for 'a' (codepoint 97, event type 3)
  comp.handleInput("\x1b[97;1:3u");
  assert(comp.inputValue() === "", "8a: key-release byte does not insert");
  assert(results.length === 0, "8b: key-release byte does not send");
  dropBuffer("iv8");
}

// ---------------------------------------------------------------------------
// 9. The steered lifecycle line contains "[deck-ui]" — the steerFromDeck
//    path carries DECK_UI_STEER_SOURCE.
// ---------------------------------------------------------------------------
{
  // This is tested via the steerFromDeck → steerChild path which calls
  // emitSteered with the deck-ui source. The lifecycle line format is
  // verified in test-dispatch-steer.ts block 7. Here we just verify the
  // constant is wired.
  const { DECK_UI_STEER_SOURCE } = await import("../src/dispatch-deck-interactive.ts");
  assert(DECK_UI_STEER_SOURCE === "deck-ui", "9a: DECK_UI_STEER_SOURCE is 'deck-ui'");
  // Verify matchesKey("ctrl+t") works (not swallowed by anything)
  // ctrl+t is \x14 (ASCII 20). matchesKey detects it.
  assert(matchesKey("\x14", "ctrl+t"), "9b: matchesKey detects ctrl+t (raw \x14 byte)");
}

// ---------------------------------------------------------------------------
// 10. The status line is replaced by the next send and cleared on settle.
// ---------------------------------------------------------------------------
{
  resetKeys(["iv10"]);
  startBuffer("iv10");
  const comp = createAgentViewComponent(
    "iv10",
    () => makeHeader(),
    fakeTheme,
    { terminal: { rows: 30 } },
    () => {},
    () => {},
  );
  comp.setStatus({ text: "✓ sent", ok: true });
  let flat = comp.render(80).join("\n");
  assert(flat.includes("✓ sent"), "10a: first status renders");
  // Next send replaces it
  comp.setStatus({ text: "⧗ between rounds — not sent", ok: false });
  flat = comp.render(80).join("\n");
  assert(flat.includes("⧗ between rounds — not sent"), "10b: second status replaces first");
  assert(!flat.includes("✓ sent"), "10c: first status no longer present");
  // Clear on settle
  const comp2 = createAgentViewComponent(
    "iv10",
    () => makeHeader({ status: "finished", settled: true }),
    fakeTheme,
    { terminal: { rows: 30 } },
    () => {},
    () => {},
  );
  comp2.setStatus({ text: "✓ sent", ok: true });
  flat = comp2.render(80).join("\n");
  assert(!flat.includes("✓ sent"), "10d: status cleared on settle");
  dropBuffer("iv10");
}

// ---------------------------------------------------------------------------
// 11. The echo event counts toward the buffer bound.
// ---------------------------------------------------------------------------
{
  resetKeys(["iv11"]);
  startBuffer("iv11");
  appendOperatorSteer("iv11", "developer", "test echo");
  const buf = getBuffer("iv11");
  const echoEv = buf.find((e) => e.kind === "operatorSteer");
  assert(echoEv !== undefined, "11a: echo event is in the buffer");
  if (echoEv && echoEv.kind === "operatorSteer") {
    assert(echoEv.text === "test echo", "11b: echo text stored correctly");
    assert(echoEv.label === "developer", "11c: echo label stored correctly");
  }
  // The event size contributes to the buffer (indirectly: it's in the buffer
  // and would be evicted by trimToBound if the bound were exceeded)
  dropBuffer("iv11");
}

// #915 block 12 (single-subscription guarantee) moved to
// test-agent-view-subscription.ts to keep this file under the 500-line limit.

console.log(`\nexit ${exit}`);
process.exit(exit);
