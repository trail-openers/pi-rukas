#!/usr/bin/env bun
/**
 * Pure unit tests for the dispatch deck's single composite widget (#729,
 * #742, #834). #834 replaced the non-focusable SelectList (which never
 * received input — keys route to the focused editor, #176) with plain per-job
 * Text rows, one per RUNNING job (batch members included), plus the
 * roster-mode input listener. Covers: buildSteerPrompt, the
 * ONE-KEY widget invariant, and the composite factory shape (Container of
 * plain Text rows — NO SelectList children). The SelectList's encode/parse
 * value surface (deck:: prefix) was deleted with it in #834 — it had no
 * production caller.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
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
} from "../src/dispatch-deck.ts";
import { DECK_UI_STEER_SOURCE } from "../src/dispatch-deck-interactive.ts";
import {
  buildCompositeFactory,
  buildSteerPrompt,
  type DeckRows,
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

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
} as const;

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

// 7. DECK_UI_STEER_SOURCE constant is 'deck-ui'.
{
  assert(
    DECK_UI_STEER_SOURCE === "deck-ui",
    "DECK_UI_STEER_SOURCE is 'deck-ui' (new SteerSource member)",
  );
}

// 8. #729 ONE-KEY INVARIANT: setWidget is called with EXACTLY ONE key
// ("ensemble:deck") across the full attach→startEntry→render→clearEntry→
// render cycle. A second ensemble-owned key fails this test.
{
  reset();
  const calls: Array<{
    key: string;
    content: string[] | ((...args: unknown[]) => unknown) | undefined;
    options?: { placement?: string };
  }> = [];
  // hasUI/getEditorText/onTerminalInput match the other tests' ctx shape —
  // the one-key assertion is about the widget, independent of the nav
  // listener, so the ctx must not silently lean on the !hasUI early-bail.
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (
        key: string,
        content: string[] | ((...args: unknown[]) => unknown) | undefined,
        options?: { placement?: string },
      ) => {
        calls.push({ key, content, options });
      },
      setStatus: (_key: string, _text: string | undefined) => {},
      getEditorText: () => "",
      onTerminalInput: (_h: unknown) => () => {},
    },
  } as unknown as Parameters<typeof attach>[0];
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  await new Promise((r) => setImmediate(r));
  clearEntry("a");
  await new Promise((r) => setImmediate(r));

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
  const deckCall = calls.find((c) => c.key === "ensemble:deck" && c.content !== undefined);
  assert(
    typeof deckCall?.content === "function",
    "ensemble:deck widget uses factory form (Container, not string[])",
  );
  assert(
    deckCall?.options?.placement === "belowEditor",
    "ensemble:deck placement is 'belowEditor'",
  );
  const lastCall = calls[calls.length - 1];
  assert(
    lastCall?.key === "ensemble:deck" && lastCall?.content === undefined,
    "empty deck clears 'ensemble:deck' (setWidget undefined)",
  );
  detach();
}

// 9. #834 — the composite factory returns a Container of PLAIN Text rows:
// one per running job, NO SelectList child. The roster-mode `>` marker is
// rendered as a prefix on the selected row; the `↓ select subagents` hint
// appears when the hint is shown.
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
  const rows: DeckRows = { running: entries, showHint: true };
  const factory = buildCompositeFactory(() => [], () => rows, 20);
  const component = factory(null, fakeTheme);
  assert(component instanceof Container, "composite factory returns a Container");
  if (component instanceof Container) {
    // Every child is a Text row — no SelectList (the #834 replacement).
    const textChildren = component.children.filter((c) => c instanceof Text);
    assert(
      textChildren.length === component.children.length,
      "every child is a plain Text row (no SelectList, #834)",
    );
    // 2 job rows + 1 blank separator + 1 hint = 4 rows.
    assert(
      component.children.length === 4,
      `2 jobs + blank separator + hint → 4 rows (got ${component.children.length})`,
    );
    // The roster-mode hint is present (showHint=true, inactive).
    const hintRows = textChildren.filter((c) => (c as Text).text === "↓ select subagents");
    assert(hintRows.length === 1, "the '↓ select subagents' hint row is present");
    // Each job renders exactly once (one row per job, single-surface
    // invariant #709/#729/#742/#761).
    const rendered = textChildren.map((c) => (c as Text).text);
    const countFor = (label: string) => rendered.filter((l) => l.includes(label)).length;
    assert(countFor("explore") >= 2, "both jobs render (each appears in its row)");
  }
}

// 9b. Roster mode: the selected row carries the `>` marker, other rows do
// not, and the hint disappears while active.
{
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
  const rows: DeckRows = { running: entries, selectedKey: "job-b", showHint: false };
  const factory = buildCompositeFactory(() => [], () => rows, 20);
  const component = factory(null, fakeTheme);
  if (component instanceof Container) {
    const rendered = component.children
      .filter((c) => c instanceof Text)
      .map((c) => (c as Text).text)
      .filter((l) => l !== "");
    const sel = rendered.find((l) => l.startsWith("> "));
    assert(!!sel && sel.includes("read"), "selected row carries the '>' marker");
    assert(
      rendered.filter((l) => l.startsWith("> ")).length === 1,
      "exactly one row carries the '>' marker",
    );
    assert(
      !rendered.some((l) => l === "↓ select subagents"),
      "no hint row while roster mode is active",
    );
  }
}

// 9c. Empty running set: no job rows, no hint (the renderNow empty-deck
// guard removes the whole widget before this factory is reached in
// production; here we assert the factory's own behaviour).
{
  const rows: DeckRows = { running: [], showHint: false };
  const factory = buildCompositeFactory(() => [], () => rows, 20);
  const component = factory(null, fakeTheme);
  if (component instanceof Container) {
    assert(
      component.children.length === 0,
      "no running jobs, no hint → 0 rows",
    );
  }
}

// 11. #761 / #834 — batch-member single-row regression: a batch header
// renders as a Text row and each member renders exactly once as a per-job
// row (member double-render is impossible — there is no second surface).
{
  // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
  delete process.env.PI_ENSEMBLE_QUIET_STATUS;
  reset();
  startBatchEntry("b-761", { label: "developer×2", size: 2 });
  startEntry("m-761-a", { label: "developer[task-A]", role: "developer", batchKey: "b-761" });
  startEntry("m-761-b", { label: "developer[task-B]", role: "developer", batchKey: "b-761" });
  startEntry("s-761", { label: "explore", role: "explore" });
  assert(snapshot().length === 3, "canary: deck populated (3 entries) — quiet env cannot vacuate the block");
  type WCall = { key: string; content: string[] | ((...a: unknown[]) => unknown) | undefined; options?: { placement?: string } };
  const calls: WCall[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (key: string, content: WCall["content"], options?: WCall["options"]) => {
        calls.push({ key, content, options });
      },
      setStatus: (_k: string, _t: string | undefined) => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof attach>[0];
  attach(ctx);
  await new Promise((r) => setImmediate(r));
  const fc = calls.find((c) => typeof c.content === "function");
  assert(typeof fc?.content === "function", "factory present");
  const comp = (fc?.content as unknown as (t: unknown, x: unknown) => unknown)(
    null,
    fakeTheme,
  ) as Container;
  assert(comp instanceof Container, "Container");
  if (comp instanceof Container) {
    const rendered = comp.children
      .filter((c) => c instanceof Text)
      .map((c) => (c as Text).text);
    const nonEmpty = rendered.filter((l) => l !== "");
    // The batch header renders once (via the batch-headers-only projection).
    assert(nonEmpty.some((l) => l.includes("batch[developer×2]")), "batch header in rows");
    // Each member renders exactly ONCE as a per-job row (#834: one Text
    // row per job; no SelectList second surface).
    const n = (frag: string) => nonEmpty.filter((l) => l.includes(frag)).length;
    assert(n("task-A") === 1, "member A renders exactly once");
    assert(n("task-B") === 1, "member B renders exactly once");
    assert(n("explore") >= 1, "standalone renders");
    // 1 batch header + 3 job rows + 1 blank separator + 1 hint row
    // (empty editor → hint shown) = 6 children total.
    assert(comp.children.length === 6, "batch header + 3 job rows + separator + hint");
  }
  detach();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
