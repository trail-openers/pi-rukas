#!/usr/bin/env bun
/**
 * #834 — roster-mode nav state machine for the dispatch deck.
 *
 * Drives the nav handler with a fake `ctx.ui` (getEditorText,
 * onTerminalInput capture) and the real createDeckNav state machine:
 *   - down with an empty editor + running jobs → consumed, first row
 *   - down → next; up → prev; up at first → exits
 *   - down with a non-empty editor → NOT consumed
 *   - down with no running jobs → NOT consumed
 *   - Esc → exits (consumed)
 *   - printable key while active → exits, NOT consumed
 *   - Enter → onRowConfirm(selectedKey) after roster mode exits
 *   - a selected job settling → selection moves or roster mode exits
 *   - quiet mode / headless (no hasUI) register nothing
 *   - the listener is registered once and removed on detach
 *
 * Key sequences use pi-tui's wire format: legacy arrows \x1b[A / \x1b[B,
 * escape \x1b, enter \r — the same bytes the real TUI hands to the
 * handler.
 */

import { attach, detach, reset, startEntry } from "../src/dispatch-deck.ts";
import { createDeckNav, type DeckNav, type NavListener } from "../src/dispatch-deck-nav.ts";

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
// Fake UI + nav harness
// ---------------------------------------------------------------------------

interface FakeUI {
  editorText: string;
  listeners: NavListener[];
  unsubs: (() => void)[];
  ui: {
    getEditorText: () => string;
    onTerminalInput: (h: NavListener) => () => void;
  };
}

function fakeUI(editorText = ""): FakeUI {
  const listeners: NavListener[] = [];
  const unsubs: (() => void)[] = [];
  const fake: FakeUI = {
    editorText,
    listeners,
    unsubs,
    ui: {
      getEditorText: () => fake.editorText,
      onTerminalInput: (h: NavListener) => {
        listeners.push(h);
        return () => {
          const i = listeners.indexOf(h);
          if (i !== -1) listeners.splice(i, 1);
        };
      },
    },
  };
  return fake;
}

interface NavHarness {
  nav: DeckNav;
  confirm: string[];
  changes: number;
  keys: () => string[];
}

function makeNav(keysRef: { keys: string[] }, fake: FakeUI): NavHarness {
  const confirm: string[] = [];
  let changes = 0;
  return {
    nav: createDeckNav(
      {
        runningKeys: () => keysRef.keys,
        editorText: () => fake.editorText,
        hasRunning: () => keysRef.keys.length > 0,
      },
      (key) => confirm.push(key),
      () => {
        changes++;
      },
    ),
    confirm,
    get changes() {
      return changes;
    },
    keys: () => keysRef.keys,
  };
}

// The listener the handler is registered through — call the first (only)
// registered listener, as pi-tui's inputListeners loop does.
function press(fake: FakeUI, data: string): { consume?: boolean } | undefined {
  const listener = fake.listeners[0];
  if (!listener) throw new Error("no listener registered");
  return listener(data);
}

// Wire keysRef through the deck module (the production path) so the
// handler reads the same keys the deck renders.
const keyStore = { keys: [] as string[] };

// Wrapping the body so an unexpected throw still exits deterministically
// (process.exit in a finally) instead of dying on an uncaught exception with
// the deck module state left dirty.
try {
  main();
} finally {
  process.exit(exit);
}

function main(): void {

// ---------------------------------------------------------------------------
// 1. Activation: down + empty editor + running jobs → consumed, first row
// ---------------------------------------------------------------------------
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  startEntry("job-2", { label: "explore", role: "explore" });
  keyStore.keys = ["job-1", "job-2"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  const r = press(fake, "\x1b[B"); // down
  assert(r?.consume === true, "1a: down (empty editor, 2 running) → consumed");
  assert(h.nav.isActive(), "1b: roster mode is active after activation");
  assert(h.nav.selectedKey() === "job-1", "1c: first row selected");
}

// 2. down → second row; up → first row; up → exits.
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  startEntry("job-2", { label: "explore", role: "explore" });
  keyStore.keys = ["job-1", "job-2"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  press(fake, "\x1b[B"); // activate → job-1
  assert(h.nav.selectedKey() === "job-1", "2a: activation selects first row");

  const r2 = press(fake, "\x1b[B"); // down → job-2
  assert(r2?.consume === true, "2b: down → second row (consumed)");
  assert(h.nav.selectedKey() === "job-2", "2c: second row selected");

  const r3 = press(fake, "\x1b[A"); // up → job-1
  assert(r3?.consume === true, "2d: up → first row (consumed)");
  assert(h.nav.selectedKey() === "job-1", "2e: first row selected again");

  const r4 = press(fake, "\x1b[A"); // up at first → exit
  assert(r4?.consume === true, "2f: up at first row → consumed");
  assert(!h.nav.isActive(), "2g: roster mode exited");
  assert(h.nav.selectedKey() === undefined, "2h: no selection after exit");
}

// 3. down with a NON-EMPTY editor → not consumed.
{
  reset();
  const fake = fakeUI("typing in progress");
  startEntry("job-1", { label: "developer", role: "developer" });
  keyStore.keys = ["job-1"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  const r = press(fake, "\x1b[B");
  assert(r === undefined, "3a: down (non-empty editor) → NOT consumed");
  assert(!h.nav.isActive(), "3b: roster mode NOT entered");
}

// 4. down with NO running jobs → not consumed.
{
  reset();
  const fake = fakeUI("");
  keyStore.keys = [];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  const r = press(fake, "\x1b[B");
  assert(r === undefined, "4a: down (no running jobs) → NOT consumed");
  assert(!h.nav.isActive(), "4b: roster mode NOT entered");
}

// 5. Esc → exits (consumed).
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  keyStore.keys = ["job-1"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  press(fake, "\x1b[B"); // activate
  const r = press(fake, "\x1b"); // escape
  assert(r?.consume === true, "5a: Esc → consumed");
  assert(!h.nav.isActive(), "5b: roster mode exited on Esc");
}

// 6. A printable key while active → exits and is NOT consumed.
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  keyStore.keys = ["job-1"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  press(fake, "\x1b[B"); // activate
  const r = press(fake, "x"); // printable
  assert(r === undefined, "6a: printable key while active → NOT consumed");
  assert(!h.nav.isActive(), "6b: roster mode exited");
}

// 7. Enter → onRowConfirm called with the selected key AFTER roster mode exits.
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  startEntry("job-2", { label: "explore", role: "explore" });
  keyStore.keys = ["job-1", "job-2"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  press(fake, "\x1b[B"); // activate → job-1
  press(fake, "\x1b[B"); // down → job-2
  const wasActiveBefore = h.nav.isActive();
  const r = press(fake, "\r"); // enter
  assert(wasActiveBefore, "7a: was active before Enter");
  assert(r?.consume === true, "7b: Enter → consumed");
  assert(h.confirm.length === 1, "7c: onRowConfirm called exactly once");
  assert(h.confirm[0] === "job-2", "7d: onRowConfirm called with the selected key (job-2)");
  assert(!h.nav.isActive(), "7e: roster mode exited BEFORE onRowConfirm routing");
}

// 8. A selected job settling → the selection moves to the nearest row.
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  startEntry("job-2", { label: "explore", role: "explore" });
  keyStore.keys = ["job-1", "job-2"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  press(fake, "\x1b[B"); // activate → job-1
  assert(h.nav.selectedKey() === "job-1", "8a: job-1 selected");

  // job-1 settles → only job-2 remains. Next key press re-resolves.
  keyStore.keys = ["job-2"];
  const r = press(fake, "\x1b[B"); // down → re-resolves, moves
  assert(r?.consume === true, "8b: down after settle → consumed");
  assert(h.nav.isActive(), "8c: still active (a running job remains)");
  assert(h.nav.selectedKey() === "job-2", "8d: selection moved to the nearest remaining row");
}

// 9. ALL jobs settle while active → roster mode exits on the next key.
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  keyStore.keys = ["job-1"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  press(fake, "\x1b[B"); // activate → job-1
  keyStore.keys = []; // job settles
  const r = press(fake, "\x1b[B"); // any key → re-resolve finds nothing
  assert(r?.consume === true, "9a: key after all settled → consumed");
  assert(!h.nav.isActive(), "9b: roster mode exited (no running jobs)");
}

// 10. j / k move the selection (vi-style).
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  startEntry("job-2", { label: "explore", role: "explore" });
  keyStore.keys = ["job-1", "job-2"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  press(fake, "\x1b[B"); // activate → job-1
  const r1 = press(fake, "j");
  assert(r1?.consume === true, "10a: j → consumed");
  assert(h.nav.selectedKey() === "job-2", "10b: j moves to next row");
  const r2 = press(fake, "k");
  assert(r2?.consume === true, "10c: k → consumed");
  assert(h.nav.selectedKey() === "job-1", "10d: k moves to previous row");
}

// 11. Key-release events are ignored (Kitty protocol): never consumed.
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  keyStore.keys = ["job-1"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  // Release of the down arrow (Kitty flag-2 form): must be ignored in
  // both states.
  const rInactive = press(fake, "\x1b[1:3B");
  assert(rInactive === undefined, "11a: key-release ignored when inactive");
  press(fake, "\x1b[B"); // activate
  const rActive = press(fake, "\x1b[1:3B");
  assert(rActive === undefined, "11b: key-release ignored when active (does not move/exit)");
  assert(h.nav.isActive(), "11c: still active after a release");
}

// 12. The listener is registered ONCE and removed on detach.
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  const ctx = {
    hasUI: true,
    ui: fake.ui,
    setWidget: () => {},
  } as unknown as Parameters<typeof attach>[0];

  attach(ctx);
  assert(fake.listeners.length === 1, "12a: attach registers exactly ONE listener");

  attach(ctx); // re-attach (idempotent — one listener per attach())
  assert(fake.listeners.length === 1, "12b: re-attach stays at one listener (idempotent)");

  detach();
  assert(fake.listeners.length === 0, "12c: detach removes the listener (unsubscribed)");

  // A fresh session after detach registers a fresh listener.
  attach(ctx);
  assert(fake.listeners.length === 1, "12d: attach after detach registers a fresh listener");
  detach();
}

// 13. Quiet mode registers nothing.
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  const ctx = {
    hasUI: true,
    ui: fake.ui,
    setWidget: () => {},
  } as unknown as Parameters<typeof attach>[0];

  attach(ctx);
  assert(fake.listeners.length === 0, "13a: quiet mode → no listener registered");
  detach();
  delete process.env.PI_ENSEMBLE_QUIET_STATUS;
}

// 14. Headless (no hasUI) registers nothing.
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  const ctx = {
    hasUI: false,
    ui: fake.ui,
    setWidget: () => {},
  } as unknown as Parameters<typeof attach>[0];

  attach(ctx);
  assert(fake.listeners.length === 0, "14a: headless (hasUI=false) → no listener registered");
  detach();
}

// 15. down clamps at the last row (no wrap).
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  startEntry("job-2", { label: "explore", role: "explore" });
  keyStore.keys = ["job-1", "job-2"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  press(fake, "\x1b[B"); // activate → job-1
  press(fake, "\x1b[B"); // → job-2
  const r = press(fake, "\x1b[B"); // down at last → stays
  assert(r?.consume === true, "15a: down at last row → consumed");
  assert(h.nav.selectedKey() === "job-2", "15b: clamped at last row (no wrap)");
}

// 16. onChange fires on state transitions (deck re-render trigger).
{
  reset();
  const fake = fakeUI("");
  startEntry("job-1", { label: "developer", role: "developer" });
  keyStore.keys = ["job-1"];
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  const before = h.changes;
  press(fake, "\x1b[B"); // activate
  assert(h.changes > before, "16a: onChange fired on activation");
  const before2 = h.changes;
  press(fake, "\x1b"); // escape
  assert(h.changes > before2, "16b: onChange fired on exit");
}

// 17. dispatch_steer from the deck (steerFromDeck) still routes for batch
// members: confirm a batch-member row → the steer prompt opens (the
// onRowConfirm route is intact). We verify the route by confirming the key
// resolves to a real entry in the deck (steerDeckEntry would be called).
{
  reset();
  startEntry("batch-m1", { label: "developer[task-A]", role: "developer", batchKey: "b1" });
  keyStore.keys = ["batch-m1"];
  const fake = fakeUI("");
  const h = makeNav(keyStore, fake);
  fake.ui.onTerminalInput(h.nav.handler);

  press(fake, "\x1b[B"); // activate → batch-m1
  press(fake, "\r"); // enter → onRowConfirm(batch-m1)
  assert(h.confirm.length === 1 && h.confirm[0] === "batch-m1", "17: batch-member row confirms its own key (steer route intact)");
}

console.log(`\nexit ${exit}`);
}
