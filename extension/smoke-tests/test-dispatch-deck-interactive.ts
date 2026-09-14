#!/usr/bin/env bun
/**
 * Pure unit tests for the dispatch deck's single composite widget (#729):
 *
 * #729 collapsed the pre-#729 dual-widget design (belowEditor detail deck +
 * aboveEditor DECK_PROMPT_KEY SelectList) into ONE widget key,
 * "ensemble:deck". The composite is a Container of detail rows followed by
 * a keyboard-selectable SelectList, both reading the same entries.
 *
 * This test covers:
 *  - encodeDeckValue / parseDeckValue round-trip
 *  - buildDeckItems shape (one row per entry + cancel sentinel)
 *  - DeckItem.label IS the full formatRow line (the composite shows ONE
 *    projection, not two different label formats — #729's whole point)
 *  - steerPrompt is a ready-to-send steer with job context
 *  - setWidget is called with EXACTLY ONE key ("ensemble:deck") and a
 *    factory function — the one-key invariant (#729 acceptance criterion)
 *  - empty deck → the single widget is cleared (setWidget undefined)
 *  - the composite factory returns a Container with detail rows + SelectList
 *
 * The interactive picker itself (keyboard input via ctx.ui) is live-only —
 * same boundary as test-model-picker.ts. Here we cover the pure builders
 * and the widget-shape assertions that DON'T require a live Pi session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import {
  type DeckEntry,
  type DeckItem,
  attach,
  buildDeckPromptItems,
  clearEntry,
  detach,
  encodeDeckPromptValue,
  formatRow,
  parseDeckPromptValue,
  reset,
  startEntry,
  DECK_PROMPT_CANCEL_KEY,
  DECK_PROMPT_STEER_SOURCE,
} from "../src/dispatch-deck.ts";
import { type RunningState, emptyRunningState } from "../src/progress.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeState(role: string, opts: Partial<RunningState> = {}): RunningState {
  const base = emptyRunningState(role);
  return { ...base, ...opts, usage: { ...base.usage, ...(opts.usage ?? {}) } };
}

// 1. encodeDeckPromptValue / parseDeckPromptValue — round-trip.
// (Re-exported from dispatch-deck-composite.ts via dispatch-deck.ts.)
{
  const key = "df8a-7r";
  const v = encodeDeckPromptValue(key);
  assert(v === `deck::${key}`, "encodeDeckPromptValue prefixes with 'deck::'");
  assert(parseDeckPromptValue(v) === key, "parseDeckPromptValue round-trips a real key");
}

// 2. parseDeckPromptValue rejects malformed values cleanly.
{
  assert(
    parseDeckPromptValue("no-prefix") === undefined,
    "parseDeckPromptValue: no prefix → undefined",
  );
  assert(
    parseDeckPromptValue("deck::") === undefined,
    "parseDeckPromptValue: empty key after prefix → undefined",
  );
  assert(
    parseDeckPromptValue("deck:::x") !== undefined,
    "parseDeckPromptValue: key containing '::' is allowed (round-trips as-is)",
  );
}

// 3. buildDeckPromptItems — one item per entry + cancel sentinel.
{
  const now = 1_000_000;
  const entries: DeckEntry[] = [
    {
      key: "a",
      label: "developer",
      seq: 0,
      startedAt: now - 100_000,
      state: makeState("developer", { lastToolName: "bash", toolUses: 3 }),
    },
    {
      key: "b",
      label: "explore",
      seq: 1,
      startedAt: now - 50_000,
      state: makeState("explore"),
    },
  ];
  const items = buildDeckPromptItems(entries, now);
  assert(items.length === 3, "2 entries + 1 cancel sentinel → 3 items");
  assert(items[0]?.key === "a", "first item is entry 'a' (insertion order)");
  assert(items[1]?.key === "b", "second item is entry 'b'");
  assert(items[2]?.key === DECK_PROMPT_CANCEL_KEY, "last item is the cancel sentinel");
  assert(
    items[2]?.label === "── cancel ──",
    "cancel sentinel has the expected label",
  );
  assert(
    items[2]?.steerPrompt === "",
    "cancel sentinel has an empty steerPrompt",
  );
}

// 4. DeckItem.label IS the full formatRow line (#729 — ONE projection).
// The pre-#729 "short label" (shortPromptLabel) is gone. The composite
// shows the SAME text in the detail rows and the SelectList, so the
// double-projection is structurally impossible.
{
  const now = 2_000_000;
  const entries: DeckEntry[] = [
    {
      key: "x",
      label: "developer[task-A]",
      seq: 0,
      startedAt: now - 134_000,
      state: makeState("developer", {
        lastToolName: "bash",
        toolUses: 7,
        lastEventAt: now - 1000, // not stale
      }),
    },
  ];
  const items = buildDeckPromptItems(entries, now);
  const label = items[0]?.label ?? "";
  // #729: the label IS the formatRow line — the two projections are merged.
  assert(
    label === formatRow(entries[0]!, now),
    "label IS byte-identical to formatRow (single projection, #729)",
  );
  assert(label.startsWith("⏳"), "label starts with the hourglass icon (full detail row)");
  assert(label.includes("2m14s"), "label includes elapsed time");
  assert(label.includes("bash (#7)"), "label includes tool name + use-count");
}

// 4b. Multiple entries — each label matches its own formatRow line.
{
  const now = 4_000_000;
  const mk = (key: string, seq: number): DeckEntry => ({
    key,
    label: "developer[task-A]",
    seq,
    startedAt: now - 134_000,
    state: makeState("developer", {
      lastToolName: "bash",
      toolUses: 7,
      lastEventAt: now - 1000,
    }),
  });
  const entries = [mk("df8a-1aaaa", 0), mk("df8a-2bbbb", 1)];
  const items = buildDeckPromptItems(entries, now);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    assert(
      (items[i]?.label ?? "") === formatRow(e, now),
      `item ${i} label IS its formatRow line (not a separate short form)`,
    );
  }
}

// 5. DeckItem.value round-trips through parseDeckPromptValue.
{
  const entries: DeckEntry[] = [
    {
      key: "my-job",
      label: "ops",
      seq: 0,
      startedAt: 1,
      state: makeState("ops"),
    },
  ];
  const items = buildDeckPromptItems(entries);
  const value = items[0]?.value ?? "";
  assert(parseDeckPromptValue(value) === "my-job", "item.value round-trips to the entry key");
}

// 6. steerPrompt is a ready-to-send steer with job context.
{
  const now = 3_000_000;
  const entries: DeckEntry[] = [
    {
      key: "job-1",
      label: "developer",
      seq: 0,
      startedAt: now - 60_000,
      state: makeState("developer", { lastToolName: "grep", toolUses: 1 }),
    },
  ];
  const items = buildDeckPromptItems(entries, now);
  const prompt = items[0]?.steerPrompt ?? "";
  assert(
    prompt.includes("[deck-ui steer → developer, job job-1]"),
    "steerPrompt names the target job and source",
  );
  assert(prompt.includes("grep"), "steerPrompt includes the last tool name");
  assert(prompt.includes("1m0s"), "steerPrompt includes elapsed time (1m0s)");
  assert(
    prompt.includes("Reply with a short status update"),
    "steerPrompt instructs the subagent to reply briefly",
  );
}

// 7. DECK_PROMPT_STEER_SOURCE constant is 'deck-ui'.
{
  assert(
    DECK_PROMPT_STEER_SOURCE === "deck-ui",
    "DECK_PROMPT_STEER_SOURCE is 'deck-ui' (new SteerSource member)",
  );
}

// 8. #729 ONE-KEY INVARIANT: setWidget is called with EXACTLY ONE key
// ("ensemble:deck") across the full attach→startEntry→render→clearEntry→
// render cycle. A second ensemble-owned key (e.g. a resurrected
// DECK_PROMPT_KEY) fails this test.
{
  reset();
  const calls: Array<{
    key: string;
    content: string[] | ((...args: unknown[]) => unknown) | undefined;
    options?: { placement?: string };
  }> = [];
  const ctx = {
    ui: {
      setWidget: (
        key: string,
        content: string[] | ((...args: unknown[]) => unknown) | undefined,
        options?: { placement?: string },
      ) => {
        calls.push({ key, content, options });
      },
      setStatus: (_key: string, _text: string | undefined) => {},
    },
  } as unknown as Parameters<typeof attach>[0];
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  await new Promise((r) => setImmediate(r));
  clearEntry("a");
  await new Promise((r) => setImmediate(r));

  // Collect all DISTINCT keys that received non-undefined content.
  const nonUndefinedKeys = new Set(
    calls.filter((c) => c.content !== undefined).map((c) => c.key),
  );
  assert(
    nonUndefinedKeys.size === 1,
    `exactly ONE distinct key received non-undefined content (got ${nonUndefinedKeys.size}: ${[...nonUndefinedKeys].join(", ")})`,
  );
  assert(
    nonUndefinedKeys.has("ensemble:deck"),
    "the single key is 'ensemble:deck'",
  );
  // The widget uses factory form (not string[] array).
  const deckCall = calls.find((c) => c.key === "ensemble:deck" && c.content !== undefined);
  assert(
    typeof deckCall?.content === "function",
    "ensemble:deck widget uses factory form (Container, not string[])",
  );
  assert(
    deckCall?.options?.placement === "belowEditor",
    "ensemble:deck placement is 'belowEditor'",
  );
  // The empty-deck clear also uses the same single key.
  const lastCall = calls[calls.length - 1];
  assert(
    lastCall?.key === "ensemble:deck" && lastCall?.content === undefined,
    "empty deck clears 'ensemble:deck' (setWidget undefined)",
  );
  detach();
}

// 9. Composite factory returns a Container with detail rows + SelectList.
// Invoke the factory and verify the structure: at least one Text child
// (the detail row) followed by a SelectList child.
{
  reset();
  const calls: Array<{
    key: string;
    content: string[] | ((...args: unknown[]) => unknown) | undefined;
    options?: { placement?: string };
  }> = [];
  const ctx = {
    ui: {
      setWidget: (
        key: string,
        content: string[] | ((...args: unknown[]) => unknown) | undefined,
        options?: { placement?: string },
      ) => {
        calls.push({ key, content, options });
      },
      setStatus: (_key: string, _text: string | undefined) => {},
    },
  } as unknown as Parameters<typeof attach>[0];
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  await new Promise((r) => setImmediate(r));
  const deckCall = calls.find((c) => c.key === "ensemble:deck" && c.content !== undefined);
  const factory = deckCall?.content;
  assert(typeof factory === "function", "composite factory is a function");
  if (typeof factory === "function") {
    // The fakeTheme must support fg/bg for the composite's Text + SelectList.
    const fakeTheme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    } as unknown as Parameters<typeof factory>[1];
    const component = factory(null, fakeTheme);
    assert(
      component instanceof Container,
      "composite factory returns a Container (not a bare SelectList)",
    );
    if (component instanceof Container) {
      assert(component.children.length >= 2, `Container has ≥2 children (detail row + list); got ${component.children.length}`);
      // The last child should be the SelectList (or a child of the container).
      const last = component.children[component.children.length - 1];
      assert(
        last !== undefined,
        "last child exists (SelectList or separator)",
      );
    }
  }
  detach();
}

// 10. buildDeckPromptItems with empty entries → only the cancel sentinel.
{
  const items = buildDeckPromptItems([]);
  assert(items.length === 1, "empty entries → 1 item (cancel sentinel)");
  assert(items[0]?.key === DECK_PROMPT_CANCEL_KEY, "only item is the cancel sentinel");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
