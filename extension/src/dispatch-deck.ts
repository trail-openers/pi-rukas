/**
 * Live dispatch deck (#117 / #607 / #709 / #729).
 *
 * The deck registers ONE widget — `ensemble:deck` — a composite Container
 * of detail rows (belowEditor) followed by a keyboard-selectable
 * SelectList. #729 collapsed the prior dual-projection design (a second
 * aboveEditor SelectList that re-rendered the same entries with a different
 * label format) into a single key, so the double-projection is
 * structurally impossible rather than merely de-duplicated by label text.
 *
 * Selecting a row in the composite's SelectList confirms the job: a
 * running job opens the steer prompt (`deck-ui` source tag); a settled
 * job opens the read-only transcript viewer (#607 d2/d3).
 *
 * Opt-out: PI_ENSEMBLE_QUIET_STATUS=1.
 *
 * #709's "do not remove either widget" directive is superseded — the
 * aboveEditor `ensemble:deck-prompt` widget was the source of the
 * duplicate projection and was removed in #729.
 */

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as deckComposite from "./dispatch-deck-composite.ts";
import * as deckInteractive from "./dispatch-deck-interactive.ts";
import { type RunningState, emptyRunningState, formatElapsed } from "./progress.ts";
import { trace } from "./trace.ts";

const WIDGET_KEY = "ensemble:deck";
const TICK_INTERVAL_MS = 1000;
const DECK_MAX_ROWS_DEFAULT = 20;

function getDeckMaxRows(): number {
  const raw = process.env.PI_ENSEMBLE_DECK_MAX_ROWS;
  if (!raw) return DECK_MAX_ROWS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DECK_MAX_ROWS_DEFAULT;
}

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

export const DECK_PROMPT_STEER_SOURCE = "deck-ui";
export const DECK_PROMPT_CANCEL_KEY = "__deck_prompt::cancel__";

const entries = new Map<string, DeckEntry>();
const batches = new Map<string, BatchDeckEntry>();
let activeCtx: ExtensionContext | undefined;
let pendingRender = false;
let insertionCounter = 0;
let tickHandle: ReturnType<typeof setInterval> | undefined;
let widgetVisible = false;
// #607 d2/d3 — jobIds that have settled (deck entry cleared); confirmed
// rows route to the transcript viewer instead of the steer prompt.
const settledJobs = new Set<string>();

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
  settledJobs.clear();
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
  if (!activeCtx) return;
  if (buildLines().length === 0) {
    if (widgetVisible) {
      try {
        activeCtx.ui.setWidget(WIDGET_KEY, undefined);
      } catch {}
      widgetVisible = false;
    }
    return;
  }
  const factory = buildCompositeWidgetFactory(activeCtx);
  try {
    activeCtx.ui.setWidget(WIDGET_KEY, factory, { placement: "belowEditor" });
    widgetVisible = true;
  } catch (err) {
    trace(`dispatch-deck: setWidget failed: ${(err as Error).message}`);
  }
}

/** Build the single composite widget factory (detail rows + SelectList). */
function buildCompositeWidgetFactory(ctx: ExtensionContext) {
  return deckComposite.buildCompositeFactory(() => [...entries.values()], getDeckMaxRows(), {
    onRowConfirm: (key) => {
      void onRowConfirm(ctx, key);
    },
    onSelectionChange: () => {
      scheduleRender();
    },
  });
}

/** #607 d2/d3. Route a confirmed row. */
async function onRowConfirm(ctx: ExtensionContext, key: string): Promise<void> {
  const entry = entries.get(key);
  if (!entry) return;
  if (!settledJobs.has(key)) {
    const text = await ctx.ui.editor(
      `Steer ${entry.label}`,
      deckComposite.buildSteerPrompt(entry, Date.now()),
    );
    if (text === undefined) return;
    steerDeckEntry(ctx.ui, key, text);
    return;
  }
  void deckInteractive
    .openTranscriptViewer(ctx, entry)
    .catch((e: Error) => trace(`dispatch-deck: viewer error: ${e.message}`));
}

/** Deliver a steer to a deck row's job (`deck-ui` source; routes through the shared steer core). */
export function steerDeckEntry(ctx: ExtensionUIContext, key: string, message: string): void {
  void deckInteractive.steerFromDeck(ctx, key, message);
}

/** Re-exported for backward compat with the pre-#729 prompt API (now the
 *  composite's item builder; identical value/shape). */
export const buildDeckPromptItems = deckComposite.buildDeckItems;
export type DeckPromptItem = deckComposite.DeckItem;
export const encodeDeckPromptValue = deckComposite.encodeDeckValue;
export const parseDeckPromptValue = deckComposite.parseDeckValue;

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
  const HINT_MAX = 50;
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
