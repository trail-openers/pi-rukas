#!/usr/bin/env bun
/**
 * #834 — roster-mode nav state machine for the dispatch deck.
 *
 * Drives the nav handler with a fake `ctx.ui` and the real createDeckNav
 * state machine: activation, navigation, exit, settle, quiet/headless,
 * listener lifecycle, self-heal cap, and the focus gate (#deck-nav-focus)
 * that prevents the roster from stealing ↓ from other focused components.
 *
 * Key sequences use pi-tui's wire format: legacy arrows \x1b[A / \x1b[B,
 * escape \x1b, enter \r.
 */

import { type DeckNav, type NavListener, createDeckNav } from "../src/dispatch-deck-nav.ts";
import {
  attach,
  detach,
  reset,
  setFocusedComponentProbe,
  startEntry,
} from "../src/dispatch-deck.ts";

const NAV_HEAL_MAX = 5; // must match the cap in dispatch-deck.ts

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

function makeNav(
  keysRef: { keys: string[] },
  fake: FakeUI,
  focus?: boolean | (() => boolean),
): NavHarness {
  const confirm: string[] = [];
  let changes = 0;
  return {
    nav: createDeckNav(
      {
        runningKeys: () => keysRef.keys,
        editorText: () => fake.editorText,
        // `focus` simulates the main editor being/not being the focused
        // component (the production probe reads the editor's `focused`
        // flag from the TUI — see dispatch-deck.ts editorFocused()).
        // Accepts a closure so tests can flip focus mid-sequence.
        editorFocused: () => (typeof focus === "function" ? focus() : (focus ?? true)),
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

// Call the first registered listener (as pi-tui inputListeners loop does).
function press(fake: FakeUI, data: string): { consume?: boolean } | undefined {
  const listener = fake.listeners[0];
  if (!listener) throw new Error("no listener registered");
  return listener(data);
}

// keysRef wired through the deck module (production path).
const keyStore = { keys: [] as string[] };

// Async IIFE: lets the finally process.exit wait for main() to complete.
try {
  void (async () => {
    await main();
  })()
    .catch((err: unknown) => {
      console.error(`uncaught in main: ${String(err)}`);
      process.exit(1);
    })
    .finally(() => {
      process.exit(exit);
    });
} catch (err) {
  // A synchronous throw in main's top-level statements (before the first
  // await) still surfaces here — report and exit non-zero.
  console.error(`uncaught in main: ${String(err)}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. Activation: down + empty editor + running → consumed, first row.
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

  // 2. Navigation: down → next; up → prev; up at first → exits.
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

  // 3. Non-empty editor → down NOT consumed.
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

  // 4. No running jobs → down NOT consumed.
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

  // 5. Esc → exits.
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

  // 6. Printable key while active → exits, NOT consumed.
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

  // 7. Enter → onRowConfirm(selectedKey) after roster mode exits.
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

  // 8. Selected job settling → selection moves to nearest row.
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

  // 9. All jobs settle → roster exits on next key.
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

  // 10. j/k move selection (vi-style).
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

  // 11. Key-release events ignored (Kitty protocol).
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

  // 12. Listener registered once, removed on detach.
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

  // 13. Quiet mode → no listener.
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

  // 14. Headless (no hasUI) → no listener.
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

  // 15. Down clamps at last row (no wrap).
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

  // 16. onChange fires on state transitions.
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

  // 17. Batch-member confirm routes to onRowConfirm (steer route intact).
  {
    reset();
    startEntry("batch-m1", { label: "developer[task-A]", role: "developer", batchKey: "b1" });
    keyStore.keys = ["batch-m1"];
    const fake = fakeUI("");
    const h = makeNav(keyStore, fake);
    fake.ui.onTerminalInput(h.nav.handler);

    press(fake, "\x1b[B"); // activate → batch-m1
    press(fake, "\r"); // enter → onRowConfirm(batch-m1)
    assert(
      h.confirm.length === 1 && h.confirm[0] === "batch-m1",
      "17: batch-member row confirms its own key (steer route intact)",
    );
  }

  // 18. Self-heal cap: onTerminalInput throws → capped retries + one warning.
  {
    reset();
    let rc = 0;
    let w = 0;
    const ctx = {
      hasUI: true,
      ui: {
        getEditorText: () => "",
        onTerminalInput: () => {
          rc++;
          throw new Error("boom");
        },
        notify: (_m: string, l: string) => {
          if (l === "warning") w++;
        },
        setWidget: () => {},
      },
    } as unknown as Parameters<typeof attach>[0];
    startEntry("job-1", { label: "d", role: "d" });
    attach(ctx);
    await new Promise((r) => setTimeout(r, (NAV_HEAL_MAX + 2) * 1000 + 200));
    assert(rc <= 1 + NAV_HEAL_MAX, `18a: capped (${rc})`);
    assert(w === 1, `18c: warn once (${w})`);
    detach();
  }
  console.log(`\nexit ${exit}`);
}
