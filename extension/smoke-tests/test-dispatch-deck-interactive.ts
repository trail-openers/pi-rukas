#!/usr/bin/env bun
/**
 * Pure unit tests for the dispatch deck's single composite widget (#729, #742).
 * #729 collapsed the dual-widget design into ONE widget key, "ensemble:deck".
 * #742 removed the per-job Text rows; the SelectList is the sole per-job
 * surface. Covers: encode/parse round-trip, buildDeckItems shape, one-key
 * invariant, empty-deck clear, composite factory shape (Container with
 * SelectList, no per-job Text children). Interactive picker is live-only.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import {
  type DeckEntry,
  attach,
  clearEntry,
  detach,
  formatRow,
  reset,
  snapshot,
  startBatchEntry,
  startEntry,
  DECK_PROMPT_CANCEL_KEY,
  DECK_PROMPT_STEER_SOURCE,
} from "../src/dispatch-deck.ts";
import {
  buildCompositeFactory,
  buildDeckItems,
  buildSteerPrompt,
  encodeDeckValue,
  parseDeckValue,
} from "../src/dispatch-deck-composite.ts";
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

// 1. encodeDeckValue / parseDeckValue — round-trip.
{
  const key = "df8a-7r";
  const v = encodeDeckValue(key);
  assert(v === `deck::${key}`, "encodeDeckValue prefixes with 'deck::'");
  assert(parseDeckValue(v) === key, "parseDeckValue round-trips a real key");
}

// 2. parseDeckValue rejects malformed values cleanly.
{
  assert(
    parseDeckValue("no-prefix") === undefined,
    "parseDeckValue: no prefix → undefined",
  );
  assert(
    parseDeckValue("deck::") === undefined,
    "parseDeckValue: empty key after prefix → undefined",
  );
  assert(
    parseDeckValue("deck:::x") !== undefined,
    "parseDeckValue: key containing '::' is allowed (round-trips as-is)",
  );
}

// 3. buildDeckItems — one item per entry + cancel sentinel.
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
  const items = buildDeckItems(entries, now);
  assert(items.length === 3, "2 entries + 1 cancel sentinel → 3 items");
  assert(items[0]?.key === "a", "first item is entry 'a' (insertion order)");
  assert(items[1]?.key === "b", "second item is entry 'b'");
  assert(items[2]?.key === DECK_PROMPT_CANCEL_KEY, "last item is the cancel sentinel");
  assert(
    items[2]?.label === "── cancel ──",
    "cancel sentinel has the expected label",
  );
}

// 4. #742 — the SelectList is the sole per-job surface: each item label is
// the job's full formatRow line (role + elapsed + tool call, no truncation
// at this level), and the description carries the key fragment so two
// same-role jobs stay distinguishable. (Pre-#742 this block asserted the
// label was byte-identical to the deck's buildLines Text row — that
// assertion pinned the double-projection and is replaced by the per-job
// row-count regression below.)
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
  const items = buildDeckItems(entries, now);
  const label = items[0]?.label ?? "";
  assert(
    label === formatRow(entries[0]!, now),
    "label IS the full formatRow line (sole per-job surface, #742)",
  );
  assert(label.startsWith("⏳"), "label starts with the hourglass icon");
  assert(label.includes("2m14s"), "label includes elapsed time");
  assert(label.includes("bash (#7)"), "label includes tool name + use-count");
  assert(
    (items[0]?.description ?? "").length >= 1,
    "description carries a job-key fragment for same-role disambiguation",
  );
  assert(
    items[0]?.description === "x",
    "≤10-char key 'x' renders verbatim (no 'key ' prefix, no ellipsis)",
  );
}

// 4b. Multiple entries — each label matches its own formatRow line, and
// distinct keys yield distinct descriptions (two same-role jobs stay
// tellable apart, the #729 failure mode).
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
  const entries = [mk("df8a-1aaaa", 0), mk("df8a-2bbbb", 1), mk("df8a-3cccc", 2)];
  const items = buildDeckItems(entries, now);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    assert(
      (items[i]?.label ?? "") === formatRow(e, now),
      `item ${i} label IS its formatRow line (no separate Text projection)`,
    );
  }
  assert(
    items[0]?.description !== items[1]?.description,
    "two same-role jobs carry distinct key descriptions",
  );
  // Three distinct keys → all descriptions pairwise distinct (a 2-key
  // comparison cannot fail trivially; a 3-way set can).
  const descs = items.map((it) => it?.description ?? "");
  assert(
    new Set(descs).size === items.length,
    "3 same-role jobs carry 3 distinct key descriptions",
  );
}

// 4c. #835 collision fix — same-role jobs with >10-char keys sharing the
// first 10 chars now render DISTINCT descriptions. Moved to
// test-dispatch-deck-fragments.ts; one-line pointer, no assertions here.

// 5. DeckItem.value round-trips through parseDeckValue.
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
  const items = buildDeckItems(entries);
  const value = items[0]?.value ?? "";
  assert(parseDeckValue(value) === "my-job", "item.value round-trips to the entry key");
}

// 6. buildSteerPrompt is a ready-to-send steer with job context.
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
  const prompt = buildSteerPrompt(entries[0]!, now);
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
  // The empty-deck clear also uses the same single key. #837: settling the
  // last entry keeps the widget alive (settled section), so the final call
  // is a re-registration (factory), not an undefined-clear.
  const lastCall = calls[calls.length - 1];
  assert(
    lastCall?.key === "ensemble:deck" && typeof lastCall?.content === "function",
    "settled-only deck re-registers 'ensemble:deck' (setWidget factory, not undefined)",
  );
  detach();
}

// 9. Composite factory returns a Container whose per-job surface is the
// SelectList — one visible row per job key (per-job regression, #742). The
// #742 defect: the factory used to add one Text child per buildLines row ON
// TOP of the SelectList whose labels were byte-identical formatRow lines,
// so every job rendered twice. Post-fix: 2 same-role jobs, empty lines →
// 0 Text children, 1 SelectList item per job. Pre-fix this same test
// yields 1 Text row per job and fails.
{
  reset();
  const entries: DeckEntry[] = [
    {
      key: "job-a",
      label: "explore",
      seq: 0,
      startedAt: 1_000_000,
      state: makeState("explore", { lastToolName: "bash", toolUses: 3 }),
    },
    {
      key: "job-b",
      label: "explore",
      seq: 1,
      startedAt: 1_000_500,
      state: makeState("explore", { lastToolName: "read", toolUses: 1 }),
    },
  ];
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  } as unknown as ReturnType<typeof buildCompositeFactory>[1];
  const factory = buildCompositeFactory(
    () => [],
    () => [...entries],
    () => [],
    20,
    { onRowConfirm: () => {}, onSelectionChange: () => {} },
  );
  const component = factory(null, fakeTheme);
  assert(component instanceof Container, "composite factory returns a Container (not a bare SelectList)");
  if (component instanceof Container) {
    // The blank separator Text is the one non-job Text child (it is the
    // #143 presentation separator between the batch rows and the list).
    const textChildren = component.children.filter((c) => c instanceof Text);
    assert(
      textChildren.length === 1 && (textChildren[0] as Text).text === "",
      `only the blank separator Text remains (got ${textChildren.length} Text children) — #742 removed the per-job rows`,
    );
    const lists = component.children.filter((c) => c instanceof SelectList);
    assert(lists.length === 1, "exactly one SelectList (the sole per-job surface)");
    const list = lists[0];
    if (list) {
      // Query the list through its PUBLIC surface (SelectList.items is
      // private in the 0.82.0 d.ts) — assert the job rows via the
      // description column, which is the sole per-job disambiguation
      // surface (#742) and renders in render(width) output (width > 40).
      const rendered = list.render(200);
      const frag = (key: string) =>
        key.length <= 10 ? key : `${key.slice(0, 10).trimEnd()}…`;
      const countFor = (key: string) => rendered.filter((l) => l.includes(frag(key))).length;
      for (const e of entries) {
        assert(
          countFor(e.key) === 1,
          `exactly ONE visible row for job '${e.key}' (got ${countFor(e.key)})`,
        );
      }
      // The cancel sentinel renders as "── cancel ──" — a single trailing
      // row, so visible rows = jobs + 1.
      assert(
        rendered.length === entries.length + 1,
        `SelectList renders one row per job + cancel sentinel (got ${rendered.length})`,
      );
      // The attach() → setWidget → factory wiring (ARCHITECTURE finding):
      // the production attach path must hand the composite factory to
      // setWidget, so the same wiring verified in test-dispatch-deck.ts
      // is exercised here too.
      const calls: Array<string | ((...a: unknown[]) => unknown) | undefined> = [];
      const wiringCtx = {
        ui: {
          setWidget: (_key: string, content: string | ((...a: unknown[]) => unknown) | undefined) => {
            calls.push(content);
          },
          setStatus: (_k: string, _t: string | undefined) => {},
        },
      } as unknown as Parameters<typeof attach>[0];
      attach(wiringCtx);
      startEntry("wiring-a", { label: "developer", role: "developer" });
      await new Promise((r) => setImmediate(r));
      const factoryCall = calls.find((c) => typeof c === "function");
      assert(
        typeof factoryCall === "function",
        "attach → scheduleRender wires the composite factory through setWidget",
      );
      detach();
    }
  }
}

// 10. buildDeckItems with empty entries → only the cancel sentinel.
{
  const items = buildDeckItems([]);
  assert(items.length === 1, "empty entries → 1 item (cancel sentinel)");
  assert(items[0]?.key === DECK_PROMPT_CANCEL_KEY, "only item is the cancel sentinel");
}

// 11. #761 — batch-member double-render regression. Pre-fix: member rows in
// Text AND SelectList → double render. Post-fix: Text = batch headers only.
// Distinct keys avoid the keyFragment collision (block 4c).
{
  // The canary below only works when startEntry/startBatchEntry actually
  // populate; delete the flag so an ambient quiet env can't turn the block
  // into a vacuous pass (and so a failure lands in the ledger, not a
  // process.exit before it).
  // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset" (assignment leaves the key present with undefined)
  delete process.env.PI_ENSEMBLE_QUIET_STATUS;
  reset();
  startBatchEntry("b-761", { label: "developer×2", size: 2 });
  startEntry("m-761-a", { label: "developer[task-A]", role: "developer", batchKey: "b-761" });
  startEntry("m-761-b", { label: "developer[task-B]", role: "developer", batchKey: "b-761" });
  startEntry("s-761", { label: "explore", role: "explore" });
  // Real canary: if the deck is empty here, every negative assertion below
  // passes vacuously (empty deck → empty Text → "members NOT in Text" is
  // trivially true). Fail loudly via the shared ledger instead.
  assert(snapshot().length === 3, "canary: deck populated (3 entries) — quiet env cannot vacuate the block");
  type WCall = { key: string; content: string[] | ((...a: unknown[]) => unknown) | undefined; options?: { placement?: string } };
  const calls: WCall[] = [];
  const ctx = {
    ui: {
      setWidget: (key: string, content: WCall["content"], options?: WCall["options"]) => { calls.push({ key, content, options }); },
      setStatus: (_k: string, _t: string | undefined) => {},
    },
  } as unknown as Parameters<typeof attach>[0];
  attach(ctx);
  await new Promise((r) => setImmediate(r));
  const fc = calls.find((c) => typeof c.content === "function");
  assert(typeof fc?.content === "function", "factory present");
  const th = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t } as unknown as ReturnType<typeof buildCompositeFactory>[1];
  const comp = (fc?.content as unknown as (t: unknown, x: unknown) => unknown)(null, th) as Container;
  assert(comp instanceof Container, "Container");
  if (comp instanceof Container) {
    const tl = comp.children
      .filter((c) => c instanceof Text)
      .map((c) => (c as Text)["text"] as string)
      .filter((t) => t !== "");
    assert(tl.some((l) => l.includes("batch[developer×2]")), "batch header in Text");
    assert(!tl.some((l) => l.includes("developer[task-A]")), "member A NOT in Text");
    assert(!tl.some((l) => l.includes("developer[task-B]")), "member B NOT in Text");
    const lists = comp.children.filter((c) => c instanceof SelectList);
    assert(lists.length === 1, "one SelectList");
    const list = lists[0];
    if (list) {
      const r = list.render(200);
      const n = (k: string) => r.filter((l) => l.includes(k)).length;
      assert(n("m-761-a") === 1, "member A once in SelectList");
      assert(n("m-761-b") === 1, "member B once in SelectList");
      assert(n("s-761") === 1, "standalone once in SelectList");
      assert(r.length === 4, "3 jobs + cancel sentinel");
    }
  }
  detach();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
