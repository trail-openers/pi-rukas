#!/usr/bin/env bun
/**
 * Pure unit tests for the keyboard-selectable deck rows (#607 d1):
 *  - encodeDeckPromptValue / parseDeckPromptValue round-trip
 *  - buildDeckPromptItems shape (one row per entry + cancel sentinel)
 *  - DeckPromptItem label is a SHORT form (entry label + key fragment, #709)
 *    that does NOT duplicate the belowEditor formatRow line
 *  - steerPrompt is a ready-to-send steer with job context
 *  - setWidget is called with DECK_PROMPT_KEY and a factory function
 *  - empty deck → DECK_PROMPT_KEY widget is cleared (setWidget undefined)
 *
 * The interactive picker itself (ctx.ui.custom + SelectList) is live-only —
 * same boundary as test-model-picker.ts. Here we cover the pure builders
 * and the widget-shape assertions that DON'T require a live Pi session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type DeckEntry,
  type DeckPromptItem,
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
  DECK_PROMPT_KEY,
  DECK_PROMPT_STEER_SOURCE,
} from "../src/dispatch-deck.ts";
import { shortPromptLabel } from "../src/deck-prompt-label.ts";
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
  assert(
    items[2]?.label === "── cancel ──",
    "cancel sentinel has the expected label",
  );
  assert(
    items[2]?.steerPrompt === "",
    "cancel sentinel has an empty steerPrompt",
  );
  // #709 — DeckPromptItem.description stays undefined; the short label (not a
  // description) is the row's only distinguishing content.
  assert(
    items[0]?.description === undefined && items[1]?.description === undefined,
    "DeckPromptItem.description stays undefined (not populated by the fix)",
  );
}

// 4. DeckPromptItem.label is the SHORT form (#709) — entry label + key
// fragment, NOT the full belowEditor formatRow line. Anchored to the same
// fixture the old block-4 assertions used (bash (#7), 2m14s).
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
  assert(label.startsWith("developer[task-A]"), "short label starts with the entry label");
  assert(label.includes("x"), "short label ends with the key fragment");
  assert(!label.startsWith("⏳"), "short label does NOT start with the hourglass icon");
  assert(!label.includes("2m14s"), "short label does NOT include elapsed time");
  assert(!label.includes("bash"), "short label does NOT include the tool name");
  assert(!label.includes("STALE"), "short label does NOT include the STALE badge");
  // Non-duplication regression (#709): the aboveEditor short label must never
  // be byte-identical to the belowEditor full status line.
  assert(
    label !== formatRow(entries[0]!, now),
    "short label is NOT byte-identical to the belowEditor formatRow line",
  );
}

// 4b. Multiple same-role entries stay distinguishable via the key fragment,
// and the belowEditor full line is never duplicated by any prompt label.
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
  const [l0, l1] = [items[0]?.label ?? "", items[1]?.label ?? ""];
  assert(l0 !== l1, "two same-role entries produce DISTINCT short labels");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    assert(
      (items[i]?.label ?? "") !== formatRow(e, now),
      `prompt label ${i} is not byte-identical to the belowEditor line`,
    );
  }
}

// 4c. Empty entry.label → the entryLabel fallback (role / role[tag]) keeps
// the short label non-empty; never a bare "· <key>".
{
  const items = buildDeckPromptItems(
    [
      {
        key: "df8a-1xxxxx",
        label: "",
        seq: 0,
        startedAt: 1,
        state: makeState("explore"),
      },
      {
        key: "df8a-2yyyyy",
        label: "",
        seq: 1,
        startedAt: 1,
        state: makeState("developer", { tag: "ux-web" }),
      },
    ],
    5_000_000,
  );
  const l0 = items[0]?.label ?? "";
  const l1 = items[1]?.label ?? "";
  assert(l0.startsWith("explore · "), "empty label falls back to role before the key fragment");
  assert(l1.startsWith("developer[ux-web] · "), "empty label falls back to role[tag] before the key fragment");
  assert(!l0.startsWith("·"), "no bare '· <key>' when entry.label is empty");
  assert(!l1.startsWith("·"), "no bare '· <key>' when entry.label is empty (tagged)");
  assert(l0 !== l1, "two empty-label entries stay distinguishable via the key fragment");
}

// 4d. shortPromptLabel helper (deck-prompt-label.ts) — the pure form.
{
  const s = shortPromptLabel({ label: "", state: makeState("explore"), key: "df8a-1xxxxx" }); // 11-char key
  assert(s.startsWith("explore · "), "shortPromptLabel: role fallback + key fragment");
  assert(s.endsWith("…"), "shortPromptLabel: long key is truncated with an ellipsis");
  const short = shortPromptLabel({ label: "ops", state: makeState("ops"), key: "df8a-1aa" }); // 8-char key
  assert(short === "ops · df8a-1aa", "shortPromptLabel: short key stays whole (no ellipsis)");
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

// 8. setWidget is called with DECK_PROMPT_KEY and a factory function when entries exist.
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
  // find the DECK_PROMPT_KEY call
  const promptCall = calls.find((c) => c.key === DECK_PROMPT_KEY);
  assert(promptCall !== undefined, "setWidget called with DECK_PROMPT_KEY");
  assert(
    typeof promptCall?.content === "function",
    "DECK_PROMPT_KEY widget uses factory form (SelectList, not string[])",
  );
  assert(
    promptCall?.options?.placement === "aboveEditor",
    "DECK_PROMPT_KEY placement is 'aboveEditor'",
  );
  detach();
}

// 9. Empty deck → DECK_PROMPT_KEY widget is cleared (setWidget undefined).
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
  const lastPromptCall = calls
    .slice(callsBeforeClear)
    .find((c) => c.key === DECK_PROMPT_KEY);
  assert(
    lastPromptCall !== undefined && lastPromptCall.content === undefined,
    "empty deck → DECK_PROMPT_KEY widget cleared (setWidget undefined)",
  );
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
