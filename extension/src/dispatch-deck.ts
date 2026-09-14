/**
 * Live dispatch deck. The ONE ensemble-owned live widget: a keyboard-
 * selectable SelectList placed belowEditor showing in-flight subagents
 * (#117, #119 "deck is sole live surface").
 *
 * #729 collapses the two dual-surface widgets introduced by #702 (a
 * belowEditor detail deck `ensemble:deck` AND an aboveEditor keyboard-`
 * selectable prompt list `ensemble:deck-prompt`) into a single widget key,
 * `ensemble:deck`. The second `ensemble:deck-prompt` key is gone; a second
 * ensemble-owned live region is now structurally impossible, not merely
 * de-duplicated by label text.
 *
 * Keyboard capability (#607 d1/d2/d3) is preserved inside the single widget:
 * confirming a running job opens the steer prompt (source tag `deck-ui`);
 * confirming a settled job opens the read-only transcript viewer. The
 * `── cancel ──` row survives as the last SelectList row, so cancelling a
 * steer/editor prompt is unchanged. `deck-prompt-label.ts` (shortPromptLabel, #709) is
 * deleted: it existed only to make two now-merged surfaces textually distinct.
 *
 * #709's "do not remove either widget" directive is SUPERSEDED by #729.
 *
 * Opt-out: PI_ENSEMBLE_QUIET_STATUS=1.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, type TUI, getKeybindings } from "@earendil-works/pi-tui";
import * as deckInteractive from "./dispatch-deck-interactive.ts";
import { type RunningState, emptyRunningState, formatElapsed } from "./progress.ts";
import { trace } from "./trace.ts";

const WIDGET_KEY = "ensemble:deck";
const HINT_MAX = 50;
const TICK_INTERVAL_MS = 1000;
const DECK_PROMPT_MAX_VISIBLE = 12;

export interface DeckEntry {
  key: string;
  label: string;
  state: RunningState;
  seq: number;
  startedAt: number;
  batchKey?: string;
}

export interface BatchDeckEntry {
  key: string;
  label: string;
  size: number;
  completed: number;
  seq: number;
  startedAt: number;
}

/** #607 d1 — one row of the keyboard-selectable deck. */
export interface DeckPromptItem {
  key: string;
  value: string;
  label: string;
  steerPrompt: string;
  description?: string;
}

/** #729 — the single widget key; a second ensemble-owned key no longer exists. */
export const DECK_PROMPT_KEY = WIDGET_KEY;
export const DECK_PROMPT_STEER_SOURCE = "deck-ui";
export const DECK_PROMPT_CANCEL_KEY = "__deck_prompt::cancel__";

const CANCEL_SENTINEL: DeckPromptItem = {
  key: DECK_PROMPT_CANCEL_KEY,
  value: encodeDeckPromptValue(DECK_PROMPT_CANCEL_KEY),
  label: "── cancel ──",
  steerPrompt: "",
};
// JobIds that have settled (deck entry cleared) — confirmed rows route to
// the transcript viewer instead of the steer prompt (#607 d2/d3).
const settledJobs = new Set<string>();
const entries = new Map<string, DeckEntry>();
const batches = new Map<string, BatchDeckEntry>();
let activeCtx: ExtensionContext | undefined;
let pendingRender = false;
let insertionCounter = 0;
let tickHandle: ReturnType<typeof setInterval> | undefined;
let widgetVisible = false;

function isQuiet(): boolean {
  return process.env.PI_ENSEMBLE_QUIET_STATUS === "1";
}

function nextSeq(): number {
  return insertionCounter++;
}

export function attach(ctx: ExtensionContext): void {
  activeCtx = ctx;
  if (entries.size > 0 || batches.size > 0) {
    startTickerIfNeeded();
    scheduleRender();
  }
}

export function detach(): void {
  stopTicker();
  if (activeCtx && widgetVisible) {
    try {
      activeCtx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {}
  }
  activeCtx = undefined;
  entries.clear();
  batches.clear();
  pendingRender = false;
  widgetVisible = false;
}

export interface StartEntryOpts {
  label: string;
  role: string;
  tag?: string;
  batchKey?: string;
}

export function startEntry(key: string, opts: StartEntryOpts): void {
  if (isQuiet()) return;
  entries.set(key, {
    key,
    label: opts.label,
    state: emptyRunningState(opts.role, opts.tag),
    seq: nextSeq(),
    startedAt: Date.now(),
    batchKey: opts.batchKey,
  });
  startTickerIfNeeded();
  scheduleRender();
}

export function updateEntry(key: string, state: RunningState): void {
  if (isQuiet()) return;
  const e = entries.get(key);
  if (!e) return;
  e.state = state;
  scheduleRender();
}

export function clearEntry(key: string): void {
  if (!entries.delete(key)) return;
  settledJobs.add(key);
  scheduleRender();
  if (entries.size === 0 && batches.size === 0) stopTicker();
}

// =============================================================================
// Selectable deck rows (#607 d1)
// =============================================================================

export function encodeDeckPromptValue(key: string): string {
  return `deck::${key}`;
}

export function parseDeckPromptValue(value: string): string | undefined {
  const prefix = "deck::";
  if (!value.startsWith(prefix)) return undefined;
  const key = value.slice(prefix.length);
  return key.length > 0 ? key : undefined;
}

export function buildDeckPromptItems(
  entries: readonly DeckEntry[],
  now: number = Date.now(),
): DeckPromptItem[] {
  const items: DeckPromptItem[] = entries.map((e) => ({
    key: e.key,
    value: encodeDeckPromptValue(e.key),
    label: formatRow(e, now),
    steerPrompt: buildSteerPrompt(e, now),
  }));
  items.push(CANCEL_SENTINEL);
  return items;
}
function buildSteerPrompt(e: DeckEntry, now: number): string {
  const elapsed = formatElapsed(Math.max(0, now - e.startedAt));
  const tool = e.state.lastToolName ? ` (last tool: ${e.state.lastToolName})` : "";
  return `[deck-ui steer → ${e.label}, job ${e.key}]\nReply with a short status update (≤3 lines), then continue. Running ${elapsed}${tool}.`;
}

/** Deliver a steer to a deck row's job (`deck-ui` source; routes through the shared steer core). */
export function steerDeckEntry(ctx: ExtensionUIContext, key: string, message: string): void {
  void deckInteractive.steerFromDeck(ctx, key, message);
}

export interface StartBatchEntryOpts {
  label: string;
  size: number;
}

export function startBatchEntry(key: string, opts: StartBatchEntryOpts): void {
  if (isQuiet()) return;
  batches.set(key, {
    key,
    label: opts.label,
    size: opts.size,
    completed: 0,
    seq: nextSeq(),
    startedAt: Date.now(),
  });
  startTickerIfNeeded();
  scheduleRender();
}

export function updateBatchProgress(key: string, completed: number): void {
  if (isQuiet()) return;
  const b = batches.get(key);
  if (!b) return;
  b.completed = Math.max(b.completed, completed);
  scheduleRender();
}

export function clearBatchEntry(key: string): void {
  if (!batches.delete(key)) return;
  scheduleRender();
  if (entries.size === 0 && batches.size === 0) stopTicker();
}

export function snapshot(): DeckEntry[] {
  return [...entries.values()].map((e) => ({
    ...e,
    state: { ...e.state, usage: { ...e.state.usage } },
  }));
}

export function batchSnapshot(): BatchDeckEntry[] {
  return [...batches.values()].map((b) => ({ ...b }));
}

export function reset(): void {
  stopTicker();
  entries.clear();
  batches.clear();
  activeCtx = undefined;
  pendingRender = false;
  insertionCounter = 0;
  widgetVisible = false;
}

export function isTicking(): boolean {
  return tickHandle !== undefined;
}

function startTickerIfNeeded(): void {
  if (tickHandle !== undefined || isQuiet()) return;
  tickHandle = setInterval(() => {
    if (entries.size === 0 && batches.size === 0) return;
    scheduleRender();
  }, TICK_INTERVAL_MS);
  tickHandle.unref?.();
}

function stopTicker(): void {
  if (tickHandle === undefined) return;
  clearInterval(tickHandle);
  tickHandle = undefined;
}

function scheduleRender(): void {
  if (pendingRender) return;
  pendingRender = true;
  setImmediate(() => {
    pendingRender = false;
    renderNow();
  });
}

function renderNow(): void {
  const ctx = activeCtx;
  if (!ctx) return;
  try {
    if (entries.size === 0 && batches.size === 0) {
      if (widgetVisible) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        widgetVisible = false;
      }
      return;
    }
    ctx.ui.setWidget(
      WIDGET_KEY,
      ((tui: TUI, theme: Theme) => buildDeckSelectList(ctx, tui, theme)) as unknown as (
        tui: TUI,
        theme: Theme,
      ) => SelectList,
      { placement: "belowEditor" },
    );
    widgetVisible = true;
  } catch (err) {
    trace(`dispatch-deck: setWidget failed: ${(err as Error).message}`);
  }
}

/**
 * #729 — the single composite widget: one `SelectList` (returned directly,
 * #176 — Container swallows keystrokes) holding the in-flight rows plus the
 * cancel sentinel. A running row opens the steer prompt; a settled row opens
 * the transcript viewer. The cancel row's editor-prompt role is unchanged.
 */
function buildDeckSelectList(ctx: ExtensionContext, _tui: TUI, theme: Theme): SelectList {
  const items = buildDeckPromptItems([...entries.values()]).map((it) => ({
    value: it.value,
    label: it.label,
    description: it.description,
  }));
  const tl = {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.bg("selectedBg", t),
    description: (t: string) => theme.fg("dim", t),
    scrollInfo: (t: string) => theme.fg("muted", t),
    noMatch: (t: string) => theme.fg("muted", t),
  };
  const list = new SelectList(items, DECK_PROMPT_MAX_VISIBLE, tl, {
    minPrimaryColumnWidth: 24,
    maxPrimaryColumnWidth: 60,
  });
  const kb = getKeybindings();
  const orig = list.handleInput.bind(list);
  list.handleInput = (data: string): void => {
    if (kb.matches(data, "tui.select.confirm")) {
      const cur = findPromptItemByValue(list.getSelectedItem()?.value ?? "");
      if (cur && cur.key !== DECK_PROMPT_CANCEL_KEY) void onRowConfirm(ctx, cur.key);
      return;
    }
    orig(data);
  };
  return list;
}
function findPromptItemByValue(value: string): DeckPromptItem | undefined {
  return parseDeckPromptValue(value)
    ? buildDeckPromptItems([...entries.values()]).find((it) => it.value === value)
    : undefined;
}

/** #607 d2/d3. Route a confirmed row: a running job opens the steer prompt; a settled job opens the read-only transcript viewer. */
async function onRowConfirm(ctx: ExtensionContext, key: string): Promise<void> {
  const entry = entries.get(key);
  if (!entry) return;
  if (!settledJobs.has(key)) {
    const text = await ctx.ui.editor(`Steer ${entry.label}`, buildSteerPrompt(entry, Date.now()));
    if (text === undefined) return;
    steerDeckEntry(ctx.ui, key, text);
    return;
  }
  void deckInteractive
    .openTranscriptViewer(ctx, entry)
    .catch((e: Error) => trace(`dispatch-deck: viewer error: ${e.message}`));
}

// =============================================================================
// Row rendering
// =============================================================================

export function buildLines(now: number = Date.now()): string[] {
  const byBatch = new Map<string, DeckEntry[]>();
  const standalone: DeckEntry[] = [];
  for (const e of entries.values()) {
    if (e.batchKey && batches.has(e.batchKey)) {
      const arr = byBatch.get(e.batchKey) ?? [];
      arr.push(e);
      byBatch.set(e.batchKey, arr);
    } else {
      standalone.push(e);
    }
  }
  type TL = { kind: "batch"; b: BatchDeckEntry } | { kind: "single"; e: DeckEntry };
  const tl: TL[] = [
    ...[...batches.values()].map((b) => ({ kind: "batch" as const, b })),
    ...standalone.map((e) => ({ kind: "single" as const, e })),
  ];
  tl.sort(
    (a, b) => (a.kind === "batch" ? a.b.seq : a.e.seq) - (b.kind === "batch" ? b.b.seq : b.e.seq),
  );
  const lines: string[] = [];
  for (const item of tl) {
    if (item.kind === "batch") {
      lines.push(formatBatchRow(item.b, now));
      for (const m of (byBatch.get(item.b.key) ?? []).slice().sort((a, b) => a.seq - b.seq)) {
        lines.push(formatMemberRow(m, now));
      }
    } else {
      lines.push(formatRow(item.e, now));
    }
  }
  return lines;
}

const STALE_THRESHOLD_MS = (() => {
  const env = Number(process.env.PI_ENSEMBLE_STALE_THRESHOLD_MS);
  return Number.isFinite(env) && env >= 1000 ? env : 15 * 60_000;
})();

function isStale(entry: { state: RunningState; startedAt: number }, now: number): boolean {
  const last = entry.state.lastEventAt ?? entry.startedAt;
  return now - last >= STALE_THRESHOLD_MS;
}

function entryLabel(e: { label: string; state: RunningState }): string {
  return e.label || (e.state.tag ? `${e.state.role}[${e.state.tag}]` : e.state.role);
}

function truncateHint(s: string): string {
  const oneLine = s.replaceAll(/\s+/g, " ").trim();
  if (oneLine.length <= HINT_MAX) return oneLine;
  return `${oneLine.slice(0, HINT_MAX - 1).trimEnd()}…`;
}

function formatRowCore(
  entry: { label: string; state: RunningState; startedAt: number },
  now: number,
): string {
  const elapsedMs = Math.max(0, now - entry.startedAt);
  const parts: string[] = [entryLabel(entry), formatElapsed(elapsedMs)];
  if (entry.state.lastToolName) {
    parts.push(
      entry.state.toolUses > 1
        ? `${entry.state.lastToolName} (#${entry.state.toolUses})`
        : entry.state.lastToolName,
    );
    if (entry.state.lastToolHint) parts.push(truncateHint(entry.state.lastToolHint));
  }
  if (isStale(entry, now)) {
    parts.push(
      `STALE (no progress ${formatElapsed(now - (entry.state.lastEventAt ?? entry.startedAt))})`,
    );
  }
  return parts.join(" ");
}

export function formatRow(
  entry: { label: string; state: RunningState; startedAt: number },
  now: number = Date.now(),
): string {
  return `${isStale(entry, now) ? "⚠" : "⏳"} ${formatRowCore(entry, now)}`;
}

export function formatMemberRow(
  entry: { label: string; state: RunningState; startedAt: number },
  now: number = Date.now(),
): string {
  return ` ↳ ${formatRowCore(entry, now)}`;
}

export function formatBatchRow(
  batch: { label: string; size: number; completed: number; startedAt: number },
  now: number = Date.now(),
): string {
  const running = Math.max(0, batch.size - batch.completed);
  return `⏳ batch[${batch.label}] ${formatElapsed(Math.max(0, now - batch.startedAt))} · ${batch.completed}/${batch.size} done${running > 0 ? ` · ${running} running` : ""}`;
}
