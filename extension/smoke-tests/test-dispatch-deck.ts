#!/usr/bin/env bun
/**
 * Pure unit test for the dispatch deck (#117 / #129 / #131 / #136 / #139 / #141):
 *  - entries inserted in stable insertion order
 *  - update mutates in place
 *  - clear drops the row at 0s (no linger)
 *  - widget content is a string[] — Pi renders one line per element (#141)
 *  - hierarchical layout: batch headers are top-level (⏳); members do NOT
 *    appear in the buildLines projection (the SelectList is the sole
 *    per-job surface, #742); standalone (non-batched) singles are
 *    top-level too
 *  - global insertion-order traversal of top-level items, member seq within batch
 *  - empty deck → setWidget(undefined)
 *  - tool-arg hint surfaces in row (#139)
 *  - formatRow uses entry.startedAt for elapsed (not stale state.elapsedMs, #131)
 *
 * Batch-entry lifecycle, ticker lifecycle, PI_ENSEMBLE_QUIET_STATUS, and
 * detach are covered in test-dispatch-deck-lifecycle.ts (#171 file-size split).
 */

import { Container, Text } from "@earendil-works/pi-tui";
import {
  type DeckEntry,
  attach,
  buildLines,
  buildLinesBatchOnly,
  clearEntry,
  detach,
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
    hasUI: true,
    ui: {
      setWidget: (key: string, content: WidgetContent, options?: { placement?: string }) => {
        calls.push({ key, content, options });
      },
      // setStatus retained for type compatibility but not used by the deck anymore.
      setStatus: (_key: string, _text: string | undefined) => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
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

// 7. buildLines: batch + members → batch header only (member rows are the
// SelectList's, #742 — the buildLines projection is used by the renderNow
// empty-deck guard, not the composite's Text projection).
{
  reset();
  startBatchEntry("batch-x", { label: "developer×3", size: 3 });
  startEntry("m-a", { label: "developer[task-A]", role: "developer", batchKey: "batch-x" });
  startEntry("m-b", { label: "developer[task-B]", role: "developer", batchKey: "batch-x" });
  startEntry("m-c", { label: "developer[task-C]", role: "developer", batchKey: "batch-x" });
  const lines = buildLines();
  assert(lines.length === 1, "1 batch + 3 members → 1 line (batch header only, #742)");
  assert(lines[0]?.startsWith("⏳ batch["), "first line is the batch header");
  assert(!lines.some((l) => l.startsWith(" ↳ ")), "no indented member rows in buildLines (#742)");
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

// 9. buildLines: mixed — batch header + standalone in dispatch order (#141).
// Member rows are absent (SelectList's, #742); the batch header and the
// standalone appear in insertion order.
{
  reset();
  startBatchEntry("b1", { label: "developer×2", size: 2 });
  startEntry("m1", { label: "developer[task-A]", role: "developer", batchKey: "b1" });
  startEntry("m2", { label: "developer[task-B]", role: "developer", batchKey: "b1" });
  startEntry("solo", { label: "explore", role: "explore" });
  const lines = buildLines();
  // Expected: batch header, standalone (members absent — SelectList's, #742)
  assert(lines.length === 2, "1 batch + 2 members + 1 standalone → 2 lines (#742)");
  assert(lines[0]?.startsWith("⏳ batch["), "batch header first");
  assert(
    lines[1]?.startsWith("⏳ explore"),
    "standalone appears after the batch header",
  );
}

// 10. buildLines: top-level traversal respects global insertion order — standalone before batch.
// Member rows are absent (SelectList's, #742); standalone and batch header appear in insertion order.
{
  reset();
  startEntry("solo", { label: "explore", role: "explore" });
  startBatchEntry("b1", { label: "developer×2", size: 2 });
  startEntry("m1", { label: "developer[task-A]", role: "developer", batchKey: "b1" });
  startEntry("m2", { label: "developer[task-B]", role: "developer", batchKey: "b1" });
  const lines = buildLines();
  assert(lines.length === 2, "1 standalone + 1 batch + 2 members → 2 lines (#742)");
  assert(lines[0]?.startsWith("⏳ explore"), "standalone first (inserted before batch)");
  assert(lines[1]?.startsWith("⏳ batch["), "batch header second");
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
  // Invoke the factory and count Container children: #834 replaced the
  // SelectList with plain per-job Text rows — 2 job rows + 1 blank
  // separator + 1 hint row (empty editor → hint shown) = 4.
  const children = renderFactoryChildren(last?.content);
  assert(
    children.length === 4,
    `factory returns a Container with 2 job rows + blank + hint (#834); got ${children.length}`,
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
  // #834: 25 job rows (one per entry) + 1 blank separator + 1 hint = 27
  // children. The per-job rows are plain Text — there is no SelectList to
  // cap them, so the cap (batch headers only) no longer bounds the list.
  const children = renderFactoryChildren(last?.content);
  assert(
    children.length === 27,
    `25 entries → 27 children (25 job rows + blank + hint, #834); got ${children.length}`,
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

// 12b. #761 (cc10e75 near-miss) — superset invariant: a deck holding ONLY a
// batch + its members (no standalone entries) must NOT be treated as empty.
// The cc10e75 predicate attempt made buildLines() return EMPTY for exactly
// this shape, which would have made renderNow's empty-deck guard clear the
// widget on every render. A deck whose only renderable thing is a batch
// header must render it.
{
  reset();
  startBatchEntry("sup-761", { label: "developer×2", size: 2 });
  startEntry("sup-a", { label: "developer[task-A]", role: "developer", batchKey: "sup-761" });
  startEntry("sup-b", { label: "developer[task-B]", role: "developer", batchKey: "sup-761" });
  const lines = buildLines();
  assert(lines.length === 1, "batch-only deck is NOT empty (buildLines has exactly the header)");
  assert(lines[0]?.includes("batch[developer×2]"), "the batch header is in buildLines (not hidden)");
}

// 12c. #761 superset invariant, general form: every batch-header row present
// in the batch-only projection (buildLinesBatchOnly — the composite's Text
// projection) also appears in buildLines. The two projections share a header
// formatter (formatBatchRow), so membership is a line-identity check.
// Both projections are evaluated at ONE fixed `now` (exported for exactly
// this reason): comparing two projections sampled at different Date.now()
// ticks raced a 1 ms elapsed-time boundary on CI ("0ms" vs "1ms") and
// flaked the line-identity check.
{
  reset();
  startBatchEntry("sh-1", { label: "alpha", size: 2 });
  startBatchEntry("sh-2", { label: "beta", size: 1 });
  startEntry("sh-m", { label: "developer[t]", role: "developer", batchKey: "sh-1" });
  startEntry("sh-solo", { label: "explore", role: "explore" });
  const now = Date.now();
  const batchOnly = buildLinesBatchOnly(now);
  assert(batchOnly.length === 2, "batch-only projection has 2 header rows (sanity)");
  const lines = buildLines(now);
  for (const header of batchOnly) {
    assert(lines.includes(header), `batch-header row in batch-only projection also in buildLines: ${header}`);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
