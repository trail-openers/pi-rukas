#!/usr/bin/env bun
/**
 * #916 SLICE B — the index.ts handler wiring: the list re-open is one
 * shared closure (openList), so EVERY view Esc returns to the list
 * (list → view → Esc → list → view → Esc opens the list 3 times — the
 * second Esc included), instead of the old inner literal losing its
 * onReturnToList and closing to main after the first hop.
 *
 * Driven with the REAL list component (production openJob → confirmRow
 * route: buffer exists → onRowConfirm → openLiveView → Esc →
 * done("returnToList") → onReturnToList). The fake ctx.ui.custom routes by
 * opts: overlayOptions set = the VIEW (openLiveView's full-screen shape),
 * absent = the LIST (openAgentList's plain overlay:true) — the two
 * callsites differ in exactly that option, so one fake serves both hops.
 * The view's done("returnToList") is the "Esc" (asserted on the real
 * component in test-agent-view.ts #6).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openAgentList } from "../src/agent-list.ts";
import type { DeckEntry } from "../src/dispatch-deck.ts";
import { confirmRow } from "../src/dispatch-deck.ts";
import { dropBuffer, startBuffer } from "../src/dispatch-deck-live.ts";
import { emptyRunningState } from "../src/progress.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

{
  let listOpens = 0;
  let viewOpens = 0;
  let listDone: (() => void) | undefined;
  let viewDone: ((v: string | undefined) => void) | undefined;
  let currentList: { handleInput: (d: string) => void; render: (w: number) => string[] } | undefined;
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s };
  const entry: DeckEntry = {
    key: "j11",
    label: "J",
    state: emptyRunningState("developer"),
    seq: 0,
    startedAt: Date.now() - 60_000,
  };
  // Buffer seeded first: onRowConfirm opens the live view whenever a
  // buffer exists, so no deck entry is needed for this wiring test.
  startBuffer("j11");
  // The fake routes by opts: overlayOptions set = the VIEW (openLiveView's
  // full-screen shape), absent = the LIST (openAgentList's plain
  // overlay:true). The list factory's return IS the real component
  // (driven below); the view's done("returnToList") is the "Esc"
  // (openLiveView's contract).
  const fakeCtx = {
    ui: {
      custom: <T,>(
        f: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
        o?: { overlayOptions?: unknown },
      ) => {
        if (o?.overlayOptions !== undefined) {
          viewOpens++;
          f({ terminal: { columns: 80 } }, theme, {}, (v: T) => viewDone?.(v));
          return new Promise<T>((r) => {
            viewDone = (v) => (r as (x: T) => void)(v as T);
          });
        }
        listOpens++;
        const p = new Promise<T>((r) => {
          listDone = () => (r as (x: T) => void)(undefined as T);
        });
        currentList = f({ terminal: { columns: 80 } }, theme, {}, () => (listDone?.(), undefined as T)) as unknown as {
          handleInput: (d: string) => void;
          render: (w: number) => string[];
        };
        return p;
      },
      editor: (_a: string, _b: string) => Promise.resolve(undefined as unknown as string),
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
    hasUI: true,
  } as unknown as ExtensionContext;

  // Production wiring under test — index.ts's handler verbatim: the shared
  // openList closure, openJob through the REAL confirmRow.
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
  const openList = (): Promise<void> =>
    openAgentList(fakeCtx, {
      getEntries: () => [entry],
      openJob: (key) => confirmRow(fakeCtx, key, { onReturnToList: () => void openList() }),
      onSettle: () => {},
    });

  // Hop 1: open list → render → down (main → job row) + Enter → openJob.
  void openList();
  await tick(5);
  assert(listOpens === 1, "1a: first hop — the list overlay opened once");
  assert(!!currentList, "1b: the list component is the real component (has handleInput)");
  currentList?.render(80);
  currentList?.handleInput("\x1b[B");
  currentList?.handleInput("\r");
  await tick();
  assert(viewOpens === 1, "1c: the view opened from the first list");

  // Esc in the view → done("returnToList") → onReturnToList re-opens the
  // list via the shared closure.
  viewDone?.("returnToList");
  await tick();
  assert(listOpens === 2, "1d: the Esc returned to the list (2nd list open)");

  // Down → Enter again from the re-opened list; Esc in the view.
  currentList?.render(80);
  currentList?.handleInput("\x1b[B");
  currentList?.handleInput("\r");
  await tick();
  assert(viewOpens === 2, "1e: the view opened from the second list");
  viewDone?.("returnToList");
  await tick();
  assert(listOpens === 3, "1f: the SECOND Esc also returned to the list (3rd list open)");

  dropBuffer("j11");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
