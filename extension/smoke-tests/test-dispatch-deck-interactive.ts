#!/usr/bin/env bun
/**
 * Pure unit tests for the dispatch deck's SINGLE composite widget (#607 d1,
 * collapsed to one key by #729):
 *  - encodeDeckPromptValue / parseDeckPromptValue round-trip
 *  - buildDeckPromptItems shape (one row per entry + cancel sentinel)
 *  - the one-key invariant: exactly ONE distinct setWidget key is ever
 *    registered across the attach → startEntry → drain → setImmediate cycle,
 *    replacing #709's string-inequality guard (which cannot detect a second
 *    ensemble-owned widget)
 *  - the single composite widget is placed belowEditor (not aboveEditor)
 *  - steerPrompt is a ready-to-send steer with job context
 *  - empty deck → the single widget key is cleared (setWidget undefined)
 *
 * The interactive picker itself (SelectList keyboard behaviour: focus,
 * arrow-nav, confirm) is live-only — same boundary as test-model-picker.ts.
 * Here we cover the pure builders and the widget-shape assertions that DON'T
 * require a live Pi session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type DeckEntry,
  attach,
  buildDeckPromptItems,
  clearEntry,
  detach,
  encodeDeckPromptValue,
  parseDeckPromptValue,
  reset,
  startEntry,
  DECK_PROMPT_CANCEL_KEY,
  DECK_PROMPT_KEY,
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
  assert(items[2]?.label === "── cancel ──", "cancel sentinel has the expected label");
  assert(items[2]?.steerPrompt === "", "cancel sentinel has an empty steerPrompt");
}

// 4. #729 — the single composite widget row label is the full formatRow line.
// The two dual surfaces were merged, so there is no separate short label; the
// row shows the full per-job status (elapsed, tool, STALE badge) that the
// belowEditor detail deck previously carried alone.
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
  assert(label.startsWith("⏳"), "row label starts with the hourglass icon (full status line)");
  assert(label.includes("developer[task-A]"), "row label includes the entry label");
  assert(label.includes("2m14s"), "row label includes elapsed time (merged detail)");
  assert(label.includes("bash"), "row label includes the tool name (merged detail)");
}

// 5. DeckPromptItem.value round-trips through parseDeckPromptValue.
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

// 8. #729 ONE-KEY INVARIANT — the structural guard that replaces #709's
// string-inequality check. Drives the real lifecycle (attach → startEntry →
// setImmediate render → clearEntry → setImmediate render) and asserts that
// exactly ONE distinct setWidget key is ever registered by the deck. A
// regression that re-introduces a second ensemble-owned widget (e.g. an
// aboveEditor `ensemble:deck-prompt`) fails here, because two distinct keys
// would then be registered.
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
  startEntry("b", { label: "explore", role: "explore" });
  await new Promise((r) => setImmediate(r));
  clearEntry("a");
  clearEntry("b");
  await new Promise((r) => setImmediate(r));
  detach();

  const distinctKeys = new Set(calls.map((c) => c.key));
  assert(
    distinctKeys.size === 1,
    `one-key invariant: exactly 1 distinct setWidget key across the whole cycle (got ${distinctKeys.size}: ${[...distinctKeys].join(", ")})`,
  );
  assert(
    distinctKeys.has("ensemble:deck"),
    "the single registered key is the deck key 'ensemble:deck'",
  );
  assert(
    !distinctKeys.has("ensemble:deck-prompt"),
    "no second ensemble-owned key ('ensemble:deck-prompt') is registered",
  );
}

// 9. The single composite widget is placed belowEditor (not the old
// aboveEditor second region), and uses the factory form.
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

  const deckCall = calls.find((c) => c.key === "ensemble:deck");
  assert(deckCall !== undefined, "setWidget called with the deck key");
  assert(
    typeof deckCall?.content === "function",
    "the single widget uses factory form (SelectList, not string[])",
  );
  assert(
    deckCall?.options?.placement === "belowEditor",
    "the single composite widget is placed 'belowEditor'",
  );
  detach();
}

// 10. Empty deck → the single widget key is cleared (setWidget undefined).
{
  reset();
  const calls: Array<{
    key: string;
    content: string[] | ((...args: unknown[]) => unknown) | undefined;
  }> = [];
  const ctx = {
    ui: {
      setWidget: (
        key: string,
        content: string[] | ((...args: unknown[]) => unknown) | undefined,
        _options?: { placement?: string },
      ) => {
        calls.push({ key, content });
      },
      setStatus: (_key: string, _text: string | undefined) => {},
    },
  } as unknown as Parameters<typeof attach>[0];
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  await new Promise((r) => setImmediate(r));
  const callsBeforeClear = calls.length;
  clearEntry("a");
  await new Promise((r) => setImmediate(r));
  const lastClearCall = calls
    .slice(callsBeforeClear)
    .find((c) => c.key === "ensemble:deck");
  assert(
    lastClearCall !== undefined && lastClearCall.content === undefined,
    "empty deck → the single widget key is cleared (setWidget undefined)",
  );
  detach();
}

// 11. buildDeckPromptItems with empty entries → only the cancel sentinel.
{
  const items = buildDeckPromptItems([]);
  assert(items.length === 1, "empty entries → 1 item (cancel sentinel)");
  assert(items[0]?.key === DECK_PROMPT_CANCEL_KEY, "only item is the cancel sentinel");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
