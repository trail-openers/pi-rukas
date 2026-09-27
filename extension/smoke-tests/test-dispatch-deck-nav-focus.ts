#!/usr/bin/env bun
/**
 * Focus gate tests (#deck-nav-focus): the roster must NOT steal ↓ from
 * other focused components (the /model selector, ctx.ui.* dialogs,
 * overlays), and focus moving away mid-roster must exit roster mode
 * without consuming the key.
 */

import { createDeckNav } from "../src/dispatch-deck-nav.ts";
import {
  attach,
  detach,
  reset,
  setFocusedComponentProbe,
  startEntry,
} from "../src/dispatch-deck.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface FakeUI {
  editorText: string;
  listeners: ((data: string) => { consume?: boolean } | undefined)[];
  ui: {
    getEditorText: () => string;
    onTerminalInput: (h: (data: string) => { consume?: boolean } | undefined) => () => void;
  };
}

function fakeUI(editorText = ""): FakeUI {
  const listeners: ((data: string) => { consume?: boolean } | undefined)[] = [];
  return {
    editorText,
    listeners,
    ui: {
      getEditorText: () => editorText,
      onTerminalInput: (h) => {
        listeners.push(h);
        return () => {
          const i = listeners.indexOf(h);
          if (i !== -1) listeners.splice(i, 1);
        };
      },
    },
  };
}

const keyStore = { keys: [] as string[] };

function makeNav(focus: boolean | (() => boolean)) {
  const confirm: string[] = [];
  let changes = 0;
  const fake = fakeUI("");
  const nav = createDeckNav(
    {
      runningKeys: () => keyStore.keys,
      editorText: () => fake.editorText,
      editorFocused: () => (typeof focus === "function" ? focus() : focus),
    },
    (key) => confirm.push(key),
    () => {
      changes++;
    },
  );
  fake.ui.onTerminalInput(nav.handler);
  return { nav, fake, confirm, changes: () => changes };
}

function press(fake: FakeUI, data: string) {
  const listener = fake.listeners[0];
  if (!listener) throw new Error("no listener registered");
  return listener(data);
}

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
  console.error(`uncaught in main: ${String(err)}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // 19. ↓ while another component is focused → NOT consumed, no roster.
  {
    reset();
    startEntry("job-1", { label: "developer", role: "developer" });
    keyStore.keys = ["job-1"];
    const h = makeNav(false);
    const r = press(h.fake, "\x1b[B");
    assert(r === undefined, "19a: down (editor NOT focused) → NOT consumed");
    assert(!h.nav.isActive(), "19b: roster mode NOT entered");
  }

  // 20. Focus moving away mid-roster: exits without consuming.
  {
    reset();
    startEntry("job-1", { label: "developer", role: "developer" });
    keyStore.keys = ["job-1"];
    let focused = true;
    const h = makeNav(() => focused);
    press(h.fake, "\x1b[B");
    assert(h.nav.isActive(), "20a: roster active while editor focused");
    focused = false;
    const r = press(h.fake, "\x1b[B");
    assert(r === undefined, "20b: key after focus-away → NOT consumed");
    assert(!h.nav.isActive(), "20c: roster exited on focus-away");
    focused = true;
    const r2 = press(h.fake, "\x1b[B");
    assert(r2?.consume === true, "20d: refocused → roster re-enters");
    assert(h.nav.isActive(), "20e: roster re-entered");
  }

  // 21. Throwing probe: propagates, roster not entered.
  {
    reset();
    startEntry("job-1", { label: "developer", role: "developer" });
    keyStore.keys = ["job-1"];
    const h = makeNav(() => {
      throw new Error("probe exploded");
    });
    let threw = false;
    try {
      press(h.fake, "\x1b[B");
    } catch {
      threw = true;
    }
    assert(threw, "21a: throwing probe propagates out of the handler");
    assert(!h.nav.isActive(), "21b: roster mode NOT entered (fail-closed)");
  }

  // 22. No TUI captured → probe false → down not consumed.
  {
    reset();
    setFocusedComponentProbe(undefined);
    startEntry("job-1", { label: "developer", role: "developer" });
    const fake = fakeUI("");
    const ctx = {
      hasUI: true,
      ui: fake.ui,
      setWidget: () => {},
    } as unknown as Parameters<typeof attach>[0];
    attach(ctx);
    assert(fake.listeners.length === 1, "22a: listener registered");
    const r = press(fake, "\x1b[B");
    assert(r === undefined, "22b: down with unprobed focus → NOT consumed");
    detach();
  }

  // 23. Probe mirrors production logic: non-editor → false, editor → true.
  {
    reset();
    startEntry("job-1", { label: "developer", role: "developer" });
    keyStore.keys = ["job-1"];
    let focusedComponent: unknown = { focused: false };
    const h = makeNav(() => {
      if (!focusedComponent || typeof focusedComponent !== "object") return false;
      return (focusedComponent as { focused?: unknown }).focused === true;
    });
    let r = press(h.fake, "\x1b[B");
    assert(r === undefined, "23b: non-editor focused → NOT consumed");
    focusedComponent = { focused: true };
    r = press(h.fake, "\x1b[B");
    assert(r?.consume === true, "23c: editor focused → roster activates");
    focusedComponent = { focused: false };
    r = press(h.fake, "x");
    assert(r === undefined, "23d: focus-away → NOT consumed (exit)");
    focusedComponent = { focused: true };
    const r1 = press(h.fake, "\x1b[B");
    const r2 = press(h.fake, "\x1b[B");
    assert(r1?.consume === true && r2?.consume === true, "23e: re-enter + move consumed");
  }

  // 15. down clamps at the last row (no wrap).
  {
    reset();
    startEntry("job-1", { label: "developer", role: "developer" });
    startEntry("job-2", { label: "explore", role: "explore" });
    keyStore.keys = ["job-1", "job-2"];
    const h = makeNav(true);
    press(h.fake, "\x1b[B"); // activate → job-1
    press(h.fake, "\x1b[B"); // → job-2
    const r = press(h.fake, "\x1b[B"); // down at last → stays
    assert(r?.consume === true, "15a: down at last row → consumed");
    assert(h.nav.selectedKey() === "job-2", "15b: clamped at last row (no wrap)");
  }

  // 16. onChange fires on state transitions (deck re-render trigger).
  {
    reset();
    startEntry("job-1", { label: "developer", role: "developer" });
    keyStore.keys = ["job-1"];
    const h = makeNav(() => true);
    press(h.fake, "\x1b[B"); // activate
    assert(h.changes() >= 1, "16a: onChange fired on activation");
    const before2 = h.changes();
    press(h.fake, "\x1b"); // escape
    assert(h.changes() > before2, "16b: onChange fired on exit");
  }

  // 17. dispatch_steer from the deck (steerFromDeck) still routes for batch
  // members: confirm a batch-member row → the steer prompt opens (the
  // onRowConfirm route is intact). We verify the route by confirming the key
  // resolves to a real entry in the deck (steerDeckEntry would be called).
  {
    reset();
    startEntry("batch-m1", { label: "developer[task-A]", role: "developer", batchKey: "b1" });
    keyStore.keys = ["batch-m1"];
    const h = makeNav(() => true);
    press(h.fake, "\x1b[B"); // activate → batch-m1
    press(h.fake, "\r"); // enter → onRowConfirm(batch-m1)
    assert(
      h.confirm.length === 1 && h.confirm[0] === "batch-m1",
      "17: batch-member row confirms its own key (steer route intact)",
    );
  }

  console.log(`\nexit ${exit}`);
}
