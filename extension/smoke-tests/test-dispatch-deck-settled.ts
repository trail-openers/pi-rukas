#!/usr/bin/env bun
/**
 * #837 — dispatch deck settled-row retention tests (epic #833 G2).
 *
 * Covers the bounded retention list (cap 20, oldest evicted first),
 * ✓/✗ outcome markers, idempotent re-settle, reset/detach clearing,
 * and the renderNow guard (settled-only deck keeps the widget alive;
 * pristine empty deck does not register).
 */

import { Container, getKeybindings, SelectList, Text } from "@earendil-works/pi-tui";
import {
  attach,
  buildLines,
  clearEntry,
  detach,
  formatSettledRow,
  reset,
  snapshot,
  startEntry,
  type DeckEntry,
} from "../src/dispatch-deck.ts";
import { buildCompositeFactory, encodeDeckValue, parseDeckValue } from "../src/dispatch-deck-composite.ts";
import { SETTLED_CAP, type SettledEntry, settledSnapshot } from "../src/dispatch-deck-settled.ts";
import { type RunningState, emptyRunningState } from "../src/progress.ts";

function makeState(role: string, opts: Partial<RunningState> = {}): RunningState {
  const base = emptyRunningState(role);
  return { ...base, ...opts, usage: { ...base.usage, ...(opts.usage ?? {}) } };
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type WidgetContent = string[] | ((tui: unknown, theme: unknown) => unknown) | undefined;
interface WidgetCall {
  key: string;
  content: WidgetContent;
  options?: { placement?: string };
}

function fakeCtx(): { calls: WidgetCall[]; ctx: Parameters<typeof attach>[0] } {
  const calls: WidgetCall[] = [];
  const ctx = {
    ui: {
      setWidget: (key: string, content: WidgetContent, options?: { placement?: string }) => {
        calls.push({ key, content, options });
      },
      setStatus: (_key: string, _text: string | undefined) => {},
    },
  } as unknown as Parameters<typeof attach>[0];
  return { calls, ctx };
}

// 1. Cap-20 eviction, oldest first.
{
  reset();
  for (let i = 0; i < SETTLED_CAP + 1; i++) {
    startEntry(`ev-${i}`, { label: `developer-${i}`, role: "developer" });
    clearEntry(`ev-${i}`);
  }
  assert(settledSnapshot().length === SETTLED_CAP, `21 settled → ${SETTLED_CAP} retained (cap)`);
  const lines = buildLines();
  assert(lines.length === SETTLED_CAP, "buildLines renders exactly the retained rows");
  assert(!lines.some((l) => l.includes("(ev-0)")), "oldest settled key (ev-0) evicted first");
  assert(lines.some((l) => l.includes("(ev-1)")), "second-oldest (ev-1) retained");
  assert(lines.some((l) => l.includes(`(ev-${SETTLED_CAP})`)), "newest settled key retained");
}

// 2. Idempotent re-settle: no duplication, position preserved.
{
  reset();
  startEntry("dup", { label: "developer", role: "developer" });
  clearEntry("dup");
  startEntry("dup", { label: "developer", role: "developer" });
  clearEntry("dup");
  assert(settledSnapshot().length === 1, "re-settle of a retained key does not duplicate");
  assert(buildLines().filter((l) => l.includes("(dup)")).length === 1, "one retained row after re-settle");
}

// 3. Failed settle (ok: false) renders ✗.
{
  reset();
  startEntry("fail-1", { label: "developer", role: "developer" });
  clearEntry("fail-1", { ok: false });
  const lines = buildLines();
  assert(lines.length === 1, "failed entry still retained");
  assert(lines[0]?.startsWith("✗ "), "failed settled row is marked ✗");
}

// 4. Success settle (ok defaults true) renders ✓.
{
  reset();
  startEntry("ok-1", { label: "developer", role: "developer" });
  clearEntry("ok-1");
  const lines = buildLines();
  assert(lines[0]?.startsWith("✓ "), "settled row is marked ✓ (ok default)");
}

// 5. formatSettledRow shape: icon + label + full key + elapsed + tool.
{
  const now = 8_000_000;
  const line = formatSettledRow(
    {
      key: "my-job-key",
      label: "developer[task-A]",
      ok: true,
      startedAt: now - 134_000,
      state: { lastToolName: "bash", toolUses: 7 },
    },
    now,
  );
  assert(line.startsWith("✓ "), "settled row starts with ✓");
  assert(
    line.includes("developer[task-A] (my-job-key)"),
    "settled row carries the FULL key (10-char fragment collisions can't alias it)",
  );
  assert(line.includes("2m14s"), "settled row shows total elapsed");
  assert(line.includes("bash (#7)"), "settled row shows final tool count");
}

// 6. clearEntry drops the row from the live snapshot; retention is separate.
{
  reset();
  startEntry("x", { label: "developer", role: "developer" });
  assert(snapshot().length === 1, "entry registered in the live snapshot");
  clearEntry("x");
  assert(snapshot().length === 0, "clear drops the entry from the LIVE snapshot (no linger)");
  assert(settledSnapshot().length === 1, "settled row moves to the retention list");
  assert(buildLines().length === 1, "settled row renders in the buildLines section");
}

// 7. reset() clears the retention list.
{
  reset();
  startEntry("r1", { label: "developer", role: "developer" });
  clearEntry("r1");
  assert(settledSnapshot().length === 1, "retention populated");
  reset();
  assert(settledSnapshot().length === 0, "reset() clears the retention list");
  assert(buildLines().length === 0, "buildLines empty after reset");
}

// 8. renderNow guard — settled-only deck keeps the widget (factory re-registered).
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  await new Promise((r) => setImmediate(r));
  clearEntry("a");
  await new Promise((r) => setImmediate(r));
  const lastCall = calls[calls.length - 1];
  assert(
    typeof lastCall?.content === "function",
    "settled-only deck keeps the widget (factory re-registered, not cleared)",
  );
  detach();
}

// 9. renderNow guard — pristine empty deck (no live, no settled) registers nothing.
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  await new Promise((r) => setImmediate(r));
  const anyContent = calls.some((c) => c.content !== undefined);
  assert(!anyContent, "pristine empty deck registers no widget (live empty + settled empty)");
}

// 10. Settled-only deck renders the settled section: Text projection carries
// the section header + rows; the SelectList carries separator + rows + cancel.
{
  reset();
  startEntry("sol-a", { label: "developer", role: "developer" });
  startEntry("sol-b", { label: "explore", role: "explore" });
  clearEntry("sol-a", { ok: true });
  clearEntry("sol-b", { ok: false });
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  await new Promise((r) => setImmediate(r));
  const fc = calls.find((c) => typeof c.content === "function");
  const th = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t } as const;
  assert(typeof fc?.content === "function", "settled-only deck registers the composite factory");
  const comp = (fc?.content as ((t: unknown, x: unknown) => unknown))(null, th) as Container;
  assert(comp instanceof Container, "Container");
  if (comp instanceof Container) {
    const texts = comp.children
      .filter((c) => c instanceof Text)
      .map((c) => (c as unknown as { text?: string }).text ?? "");
    assert(
      texts.some((t) => t.includes("settled (recently finished)")),
      "settled section header in Text projection",
    );
    assert(texts.some((t) => t.includes("developer (sol-a)")), "settled row A in Text section");
    assert(
      texts.some((t) => t.includes("✗ ") && t.includes("explore (sol-b)")),
      "failed settled row B in Text section (✗)",
    );
    const lists = comp.children.filter((c) => c instanceof SelectList);
    assert(lists.length === 1, "one SelectList on a settled-only deck");
    const list = lists[0];
    if (list) {
      const r = list.render(200);
      assert(r.length === 4, "settled-only list: separator + 2 rows + cancel sentinel");
      assert(r.some((l) => l.includes("── settled ──")), "list carries the settled separator row");
      assert(r.some((l) => l.includes("sol-a")), "settled row A selectable in list");
      assert(r.some((l) => l.includes("sol-b")), "settled row B selectable in list");
    }
  }
  detach();
}

// 11. #837 — drive the REAL composite's SelectList handleInput confirm path
// on a settled row: tui.select.confirm routes to onRowConfirm with the
// settled key (viewer path), not the steer editor. The live-entry confirm
// path is unchanged (steer). The '/' key round-trip (lens `runId/tag` keys)
// is asserted here via encode/parse — the value column is the transport.
{
  reset();
  const kb = getKeybindings();
  const confirmKey = kb.matches("\r", "tui.select.confirm") ? "\r" : "\n";
  assert(kb.matches(confirmKey, "tui.select.confirm"), "sanity: enter/CR matches the tui.select.confirm keybinding");
  const confirmed: string[] = [];
  const entries: DeckEntry[] = [
    {
      key: "live-1",
      label: "developer",
      seq: 0,
      startedAt: 1_000_000,
      state: makeState("developer"),
    },
  ];
  const settledRows: SettledEntry[] = [
    {
      key: "runIdX/fix-a", // lens/adversarial-shaped key containing '/'
      label: "developer[fix-a]",
      ok: true,
      settleSeq: 1,
      settledAt: 2_000_000,
      startedAt: 1_900_000,
      role: "developer",
      tag: "fix-a",
      state: makeState("developer", { lastToolName: "bash", toolUses: 3 }),
    },
  ];
  const factory = buildCompositeFactory(
    () => [],
    () => [...entries],
    () => [...settledRows],
    20,
    {
      onRowConfirm: (key: string) => {
        confirmed.push(key);
      },
      onSelectionChange: () => {},
    },
  );
  const th = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t } as const;
  const comp = (factory as (t: unknown, x: unknown) => unknown)(null, th) as Container;
  assert(comp instanceof Container, "Container for handleInput test");
  if (comp instanceof Container) {
    const list = comp.children.filter((c) => c instanceof SelectList)[0] as SelectList;
    if (list) {
      // Layout: [live rows..., cancel sentinel, ── settled ── separator,
      // settled rows...]. The override only intercepts the CONFIRM key —
      // every other key falls through to the stock list behaviour.
      //
      // Phase 1 — confirm on the LIVE row (index 0): onRowConfirm fires
      // with the live key (the steer path); the viewer is NOT opened.
      list.setSelectedIndex(0);
      list.handleInput(confirmKey);
      assert(confirmed.length === 1 && confirmed[0] === "live-1", "confirm on a LIVE row → onRowConfirm(live key, steer path)");
      // The cancel sentinel (index 1) is filtered by the override.
      list.setSelectedIndex(1);
      list.handleInput(confirmKey);
      assert(confirmed.length === 1, "confirm on the cancel sentinel → no onRowConfirm (filtered)");
      // Phase 2 — confirm on the SETTLED row (index 3, past the separator):
      // onRowConfirm routes settled keys to the transcript viewer, never
      // the steer editor.
      list.setSelectedIndex(3);
      list.handleInput(confirmKey);
      assert(
        confirmed.length === 2 && confirmed[1] === "runIdX/fix-a",
        "confirm on a SETTLED row → onRowConfirm(settled key, viewer path)",
      );
      // The '/' key survives the encode/parse round-trip (PM decision 3).
      assert(
        parseDeckValue(encodeDeckValue("runIdX/fix-a")) === "runIdX/fix-a",
        "encode/parse round-trips a '/'-containing deck key (lens/adversarial keys)",
      );
    }
  }
  reset();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
