#!/usr/bin/env bun
/**
 * Pure unit test for the dispatch deck (#117 / #129 / #131 / #136 / #139 / #141):
 *  - entries inserted in stable insertion order
 *  - update mutates in place
 *  - clear drops the row at 0s (no linger)
 *  - widget content is a string[] — Pi renders one line per element (#141)
 *  - hierarchical layout: batch rows are top-level (⏳); members nest under
 *    their batch with " ↳ " indent (no icon); standalone (non-batched) singles
 *    are top-level too
 *  - global insertion-order traversal of top-level items, member seq within batch
 *  - empty deck → setWidget(undefined)
 *  - tool-arg hint surfaces in row (#139)
 *  - formatRow uses entry.startedAt for elapsed (not stale state.elapsedMs, #131)
 *
 * Batch-entry lifecycle, ticker lifecycle, PI_ENSEMBLE_QUIET_STATUS, and
 * detach are covered in test-dispatch-deck-lifecycle.ts (#171 file-size split).
 */

import { Container } from "@earendil-works/pi-tui";
import {
  type DeckEntry,
  attach,
  buildLines,
  clearEntry,
  detach,
  formatMemberRow,
  formatRow,
  reset,
  snapshot,
  startBatchEntry,
  startEntry,
  updateEntry,
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

// Post-#232 the dispatch deck uses the factory form of setWidget (returns a
// Container) to bypass Pi's MAX_WIDGET_LINES=10 cap on the array form. The
// fake context captures whatever shape the production code sends through.
// biome-ignore lint/suspicious/noExplicitAny: factory return type is Pi-specific Component
type WidgetContent = string[] | ((tui: any, theme: any) => any) | undefined;
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
      // setStatus retained for type compatibility but not used by the deck anymore.
      setStatus: (_key: string, _text: string | undefined) => {},
    },
  } as unknown as Parameters<typeof attach>[0];
  return { calls, ctx };
}

// Minimal theme stub that the deck factory uses for muted-overflow text.
// Returns the text unchanged so assertions can match plainly.
const fakeTheme = { fg: (_color: string, text: string) => text } as const;

// Invoke a factory and return its child count. Used by the deck-content
// assertions post-#232 (factory form bypasses Pi's array-truncation cap).
function renderFactoryChildren(content: WidgetContent): unknown[] {
  if (typeof content !== "function") return [];
  const component = content(null, fakeTheme);
  return component instanceof Container ? component.children : [];
}

// 1. Insertion order is preserved in the snapshot.
{
  reset();
  startEntry("a", { label: "developer", role: "developer" });
  startEntry("b", { label: "explore", role: "explore" });
  startEntry("c", { label: "ops", role: "ops" });
  updateEntry("b", makeState("explore", { lastToolName: "grep" }));
  updateEntry("a", makeState("developer", { lastToolName: "bash", toolUses: 3 }));

  const keys = snapshot().map((e) => e.key);
  assert(
    JSON.stringify(keys) === '["a","b","c"]',
    "insertion order preserved after interleaved updates",
  );
}

// 2. clearEntry drops the row from the snapshot.
{
  reset();
  startEntry("x", { label: "developer", role: "developer" });
  assert(snapshot().length === 1, "entry registered");
  clearEntry("x");
  assert(snapshot().length === 0, "clear drops the entry immediately (no 0s linger)");
}

// 3. formatRow renders compact single line: icon + label + elapsed + tool.
{
  const startedAt = 1_000_000;
  const now = startedAt + 134000;
  const e: DeckEntry = {
    key: "df8a-2k",
    label: "developer",
    seq: 1,
    startedAt,
    // Provide a fresh lastEventAt so the row is NOT marked STALE (PR2 O3).
    // STALE branding is exercised separately in the "stale row" assertion
    // block below.
    state: makeState("developer", {
      elapsedMs: 999, // STALE — must not be used
      lastEventAt: now - 1000,
      lastToolName: "bash",
      toolUses: 7,
    }),
  };
  const out = formatRow(e, now);
  assert(out.startsWith("⏳"), "row starts with hourglass icon");
  assert(out.includes("developer"), "row includes label");
  assert(out.includes("2m14s"), "row includes elapsed computed from now − startedAt");
  assert(!out.includes("999"), "stale state.elapsedMs is NOT rendered");
  assert(out.includes("bash (#7)"), "row includes tool name + use-count when >1");
  assert(!out.includes("STALE"), "fresh row does not get STALE badge");
}

// 3c. PR2 O3 (retuned by #299) — STALE detection: row with no child event
// in longer than the threshold flips icon and gets a "no progress Ns" badge.
// Default threshold is now 15 min (#299): the old 90s default false-flagged
// healthy children during every long thinking turn / tool execution.
{
  const startedAt = 2_000_000;
  const now = startedAt + 20 * 60_000; // 20m elapsed
  const e: DeckEntry = {
    key: "stale-key",
    label: "developer",
    seq: 1,
    startedAt,
    state: makeState("developer", {
      lastEventAt: now - 16 * 60_000, // 16m ago > 15m threshold
      lastToolName: "bash",
      toolUses: 1,
    }),
  };
  const out = formatRow(e, now);
  assert(out.startsWith("⚠"), "STALE row uses ⚠ icon instead of ⏳");
  assert(out.includes("STALE"), "STALE row includes STALE label");
  assert(out.includes("no progress"), "STALE row names the no-progress duration");
}

// 3c-2 (#299) — a gap that would have false-flagged under the old 90s
// default (e.g. a 10-min healthy thinking turn) is NOT stale anymore.
{
  const startedAt = 2_000_000;
  const now = startedAt + 12 * 60_000;
  const e: DeckEntry = {
    key: "healthy-gap-key",
    label: "developer",
    seq: 1,
    startedAt,
    state: makeState("developer", {
      lastEventAt: now - 10 * 60_000, // 10m ago < 15m threshold
      lastToolName: "bash",
      toolUses: 1,
    }),
  };
  const out = formatRow(e, now);
  assert(!out.includes("STALE"), "#299: 10-min healthy gap no longer flags STALE");
}

// 3d. Fresh-spawn grace: a row with NO lastEventAt yet but young elapsed
// is NOT stale (provider connect time, first turn still pending).
{
  const startedAt = 3_000_000;
  const now = startedAt + 5000; // 5s elapsed, never emitted
  const e: DeckEntry = {
    key: "fresh-key",
    label: "explore",
    seq: 1,
    startedAt,
    state: makeState("explore"), // lastEventAt undefined
  };
  const out = formatRow(e, now);
  assert(out.startsWith("⏳"), "fresh row (no lastEventAt, young elapsed) is NOT stale");
  assert(!out.includes("STALE"), "fresh row does not get STALE badge");
}

// 3b. formatRow with tool-arg hint (#139).
{
  const startedAt = 5_000_000;
  const out = formatRow(
    {
      key: "df8a",
      label: "explore[ux-web]",
      seq: 2,
      startedAt,
      state: makeState("explore", {
        tag: "ux-web",
        lastToolName: "bash",
        toolUses: 14,
        lastToolHint: "parallel-cli research poll trun_ff2b6…",
      }),
    },
    startedAt + 210_000,
  );
  assert(out.includes("bash (#14)"), "row still includes tool name + count");
  assert(out.includes("parallel-cli research poll"), "row includes tool-arg hint");
}

// 4. formatMemberRow uses " ↳ " indent and no icon.
{
  const startedAt = 6_000_000;
  const out = formatMemberRow(
    {
      key: "x",
      label: "developer[task-A]",
      seq: 3,
      startedAt,
      state: makeState("developer", { lastToolName: "bash", toolUses: 5 }),
    },
    startedAt + 1000,
  );
  assert(out.startsWith(" ↳ "), "member row starts with indent prefix");
  assert(!out.includes("⏳"), "member row does not include the top-level hourglass");
  assert(out.includes("developer[task-A]"), "member row includes its label");
  assert(out.includes("bash (#5)"), "member row includes tool + count");
}

// 5. formatRow without a tool falls back to just icon + label + elapsed.
{
  const startedAt = 7_000_000;
  const out = formatRow(
    {
      key: "x",
      label: "ops",
      seq: 4,
      startedAt,
      state: makeState("ops"),
    },
    startedAt + 1000,
  );
  assert(out === "⏳ ops 1.0s", "no tool → just icon + label + elapsed");
}

// 6. buildLines: standalone singles only → one ⏳ row each in insertion order.
{
  reset();
  startEntry("a", { label: "developer", role: "developer" });
  startEntry("b", { label: "explore", role: "explore" });
  const lines = buildLines();
  assert(lines.length === 2, "two standalone singles → 2 lines");
  assert(lines[0]?.startsWith("⏳ developer"), "first standalone is developer (insertion order)");
  assert(lines[1]?.startsWith("⏳ explore"), "second standalone is explore");
  assert(!lines.some((l) => l.startsWith(" ↳ ")), "no indented rows when there are no batches");
}

// 7. buildLines: batch + members → batch header at top, members indented underneath (#141).
{
  reset();
  startBatchEntry("batch-x", { label: "developer×3", size: 3 });
  startEntry("m-a", { label: "developer[task-A]", role: "developer", batchKey: "batch-x" });
  startEntry("m-b", { label: "developer[task-B]", role: "developer", batchKey: "batch-x" });
  startEntry("m-c", { label: "developer[task-C]", role: "developer", batchKey: "batch-x" });
  const lines = buildLines();
  assert(lines.length === 4, "1 batch + 3 members → 4 lines");
  assert(lines[0]?.startsWith("⏳ batch["), "first line is the batch header");
  assert(lines[1]?.startsWith(" ↳ "), "first member is indented");
  assert(lines[1]?.includes("task-A"), "first member is task-A (insertion order)");
  assert(lines[2]?.includes("task-B"), "second member is task-B");
  assert(lines[3]?.includes("task-C"), "third member is task-C");
}

// 8. buildLines: orphan member (batchKey points to non-existent batch) becomes standalone.
{
  reset();
  startEntry("orphan", {
    label: "developer[task-X]",
    role: "developer",
    batchKey: "never-registered",
  });
  const lines = buildLines();
  assert(lines.length === 1, "orphan member → one line");
  assert(
    lines[0]?.startsWith("⏳ "),
    "orphan member renders as top-level ⏳ (not indented under missing batch)",
  );
}

// 9. buildLines: mixed — batch then standalone in dispatch order (#141).
{
  reset();
  startBatchEntry("b1", { label: "developer×2", size: 2 });
  startEntry("m1", { label: "developer[task-A]", role: "developer", batchKey: "b1" });
  startEntry("m2", { label: "developer[task-B]", role: "developer", batchKey: "b1" });
  startEntry("solo", { label: "explore", role: "explore" });
  const lines = buildLines();
  // Expected: batch header, member1, member2, solo
  assert(lines.length === 4, "1 batch + 2 members + 1 standalone → 4 lines");
  assert(lines[0]?.startsWith("⏳ batch["), "batch first");
  assert(
    lines[1]?.startsWith(" ↳ ") && lines[1].includes("task-A"),
    "member 1 indented under batch",
  );
  assert(
    lines[2]?.startsWith(" ↳ ") && lines[2].includes("task-B"),
    "member 2 indented under batch",
  );
  assert(
    lines[3]?.startsWith("⏳ explore"),
    "standalone single appears top-level AFTER the batch group",
  );
}

// 10. buildLines: top-level traversal respects global insertion order — standalone before batch.
{
  reset();
  startEntry("solo", { label: "explore", role: "explore" });
  startBatchEntry("b1", { label: "developer×2", size: 2 });
  startEntry("m1", { label: "developer[task-A]", role: "developer", batchKey: "b1" });
  startEntry("m2", { label: "developer[task-B]", role: "developer", batchKey: "b1" });
  const lines = buildLines();
  assert(lines.length === 4, "1 standalone + 1 batch + 2 members → 4 lines");
  assert(lines[0]?.startsWith("⏳ explore"), "standalone first (inserted before batch)");
  assert(lines[1]?.startsWith("⏳ batch["), "batch second");
  assert(lines[2]?.startsWith(" ↳ "), "member 1 indented");
  assert(lines[3]?.startsWith(" ↳ "), "member 2 indented");
}

// 11. attach + scheduleRender → setWidget called with factory function +
// belowEditor placement (#232 — factory form bypasses Pi's array truncation).
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  startEntry("b", { label: "explore", role: "explore" });
  await new Promise((r) => setImmediate(r));

  const last = calls[calls.length - 1];
  assert(last?.key === "ensemble:deck", "setWidget called with 'ensemble:deck' key");
  assert(
    typeof last?.content === "function",
    "setWidget called with factory function (#232 — bypasses Pi's MAX_WIDGET_LINES=10 array cap)",
  );
  // Invoke the factory and count Container children: 2 entries + 1 trailing
  // blank line (#143 presentation separator) = 3.
  const children = renderFactoryChildren(last?.content);
  assert(
    children.length === 3,
    "factory returns a Container with one Text per entry plus a trailing blank",
  );
  assert(last?.options?.placement === "belowEditor", "widget placement is 'belowEditor'");
  detach();
}

// 11b. Factory form caps at DECK_MAX_ROWS_DEFAULT (20) when exceeded, with
// overflow indicator. Avoids a runaway 50-way fanout from dominating the screen.
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  // 25 entries — exceeds the default cap of 20.
  for (let i = 0; i < 25; i++) {
    startEntry(`e${i}`, { label: `developer-${i}`, role: "developer" });
  }
  await new Promise((r) => setImmediate(r));

  const last = calls[calls.length - 1];
  assert(typeof last?.content === "function", "overflow case still uses factory form");
  // 20 entry rows + 1 overflow indicator + 1 trailing blank = 22 children.
  const children = renderFactoryChildren(last?.content);
  assert(
    children.length === 22,
    `25 entries → 22 children (20 visible + overflow indicator + trailing blank); got ${children.length}`,
  );
  detach();
}

// 12. Empty deck → setWidget(undefined) to remove the widget.
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  await new Promise((r) => setImmediate(r));
  const callsBeforeClear = calls.length;
  clearEntry("a");
  await new Promise((r) => setImmediate(r));
  const lastCall = calls[calls.length - 1];
  assert(calls.length > callsBeforeClear, "clearing the last entry triggers a new setWidget call");
  assert(lastCall?.content === undefined, "empty deck calls setWidget(key, undefined)");
  detach();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
