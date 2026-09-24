/**
 * Live dispatch deck (#117 / #607 / #709 / #729 / #742 / #834).
 *
 * The deck registers ONE widget — `ensemble:deck` — a composite Container
 * of batch Text rows followed by plain per-job rows, one per RUNNING job
 * (batch members included). #834 replaced the non-focusable SelectList
 * (which never received input — keys route to the focused editor, #176)
 * with these rows plus a roster-mode input listener (dispatch-deck-nav.ts)
 * that lets the operator walk the rows with the arrow keys from an empty
 * editor.
 *
 * Selecting a row (Enter in roster mode) confirms the job: a running job
 * opens the steer prompt (`deck-ui` source tag).
 *
 * Opt-out: PI_ENSEMBLE_QUIET_STATUS=1.
 *
 * #709's "do not remove either widget" directive is superseded — the
 * aboveEditor `ensemble:deck-prompt` widget was the source of the
 * duplicate projection and was removed in #729.
 */

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as deckComposite from "./dispatch-deck-composite.ts";
import { steerFromDeck } from "./dispatch-deck-interactive.ts";
import { type DeckNav, createDeckNav } from "./dispatch-deck-nav.ts";
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

const entries = new Map<string, DeckEntry>();
const batches = new Map<string, BatchDeckEntry>();
let activeCtx: ExtensionContext | undefined;
let pendingRender = false;
let insertionCounter = 0;
let tickHandle: ReturnType<typeof setInterval> | undefined;
let widgetVisible = false;
let nav: DeckNav | undefined;
let navUnsub: (() => void) | undefined;
let navWarned = false;
// Self-heal attempt counter: caps the renderNow retry loop so a persistent
// onTerminalInput failure (a host without the capability at all) doesn't
// re-create and re-attempt registration on every 1 s render for the whole
// session. Reset by attachNav (a new attach = a fresh budget).
let navHealAttempts = 0;
const NAV_HEAL_MAX = 5;

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
  attachNav(ctx);
}

export function detach(): void {
  stopTicker();
  if (activeCtx && widgetVisible) {
    try {
      activeCtx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {}
  }
  detachNav();
  activeCtx = undefined;
  entries.clear();
  batches.clear();
  pendingRender = false;
  widgetVisible = false;
}

/** Detach the roster-mode listener (if registered) and drop the nav state. */
function detachNav(): void {
  if (navUnsub) {
    try {
      navUnsub();
    } catch {}
    navUnsub = undefined;
  }
  nav = undefined;
}

function navGetters(ctx: ExtensionContext) {
  return {
    runningKeys: () => [...entries.values()].map((e) => e.key),
    editorText: () => {
      try {
        return ctx.ui.getEditorText();
      } catch {
        return "";
      }
    },
    hasRunning: () => entries.size > 0,
  };
}

/**
 * #834 — register the roster-mode input listener once. The listener is
 * the operator's path into the deck's running-job rows: from an empty
 * editor, `down` enters roster mode (see dispatch-deck-nav.ts). It is
 * registered only when the extension has a UI surface and the deck is
 * not quiet — quiet mode and headless mode register nothing. `detach()`
 * unsubscribes; a re-`attach` after `detach` registers a fresh listener
 * (the module-level `nav` is cleared by `detach`, so at most one
 * listener is ever live).
 */
function attachNav(ctx: ExtensionContext): void {
  if (!tryAttachNav(ctx)) detachNav();
}

/**
 * Own the full nav wiring for one attach cycle: the quiet/hasUI guards,
 * the prior-listener teardown, the createDeckNav construction and the
 * registration. Used by both `attach()` (direct) and renderNow's
 * self-heal (a transient attach-time failure retries here on a later
 * render). Returns true when the listener is live.
 */
function tryAttachNav(ctx: ExtensionContext): boolean {
  if (isQuiet() || !ctx.hasUI) return false;
  // Unsubscribe any prior listener before re-registering (attach can be
  // called more than once in a session without an intervening detach).
  detachNav();
  navWarned = false;
  navHealAttempts = 0;
  const n = createDeckNav(navGetters(ctx), (key) => void onRowConfirm(ctx, key), scheduleRender);
  if (!registerNavListener(n, ctx)) return false;
  nav = n;
  return true;
}

/**
 * Register the nav listener. Returns true on success. On failure the
 * deck still renders — only the roster-mode entry point is unavailable;
 * registration is retried on the next renderNow (self-heal for a
 * transient attach-time failure) and a persistent one surfaces a
 * one-time operator-visible warning (the trace alone is stderr-only and
 * off unless PI_ENSEMBLE_DEBUG=1).
 */
function registerNavListener(n: DeckNav, ctx: ExtensionContext): boolean {
  try {
    navUnsub = ctx.ui.onTerminalInput(n.handler);
    return true;
  } catch (err) {
    navUnsub = undefined;
    trace(`dispatch-deck: onTerminalInput unavailable: ${(err as Error).message}`);
    if (!navWarned) {
      navWarned = true;
      try {
        ctx.ui.notify(
          "Dispatch deck: arrow-key roster nav is unavailable this session (onTerminalInput not supported); rows still render.",
          "warning",
        );
      } catch {}
    }
    return false;
  }
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
  detachNav();
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
  if (entries.size === 0 && batches.size === 0) {
    if (widgetVisible) {
      try {
        activeCtx.ui.setWidget(WIDGET_KEY, undefined);
      } catch {}
      widgetVisible = false;
    }
    return;
  }
  // Self-heal a transient attach-time onTerminalInput failure: re-try the
  // roster-mode listener registration while it is absent, capped so a
  // persistent failure (a host without the capability at all) settles into
  // the degraded state instead of retrying every render forever. The
  // quiet/hasUI guards live inside tryAttachNav.
  if (nav === undefined && navHealAttempts < NAV_HEAL_MAX) {
    navHealAttempts++;
    tryAttachNav(activeCtx);
  }
  const factory = buildCompositeWidgetFactory(activeCtx);
  try {
    activeCtx.ui.setWidget(WIDGET_KEY, factory, { placement: "belowEditor" });
    widgetVisible = true;
  } catch (err) {
    trace(`dispatch-deck: setWidget failed: ${(err as Error).message}`);
  }
}

/** Build the single composite widget factory (batch rows + per-job plain
 *  rows). The Text projection reads `buildLinesBatchOnly` (batch headers
 *  only); the per-job rows are one Text row per RUNNING entry (batch
 *  members included, #834) with the roster-mode `>` marker and the
 *  `↓ select subagents` hint. renderNow's empty-deck guard tests
 *  `entries.size === 0 && batches.size === 0` directly (no projection
 *  read) so that a deck with only standalone entries still renders;
 *  `buildLines`' output is a strict superset of `buildLinesBatchOnly`'s
 *  (both contain batch headers; only `buildLines` adds standalone rows). */
function buildCompositeWidgetFactory(ctx: ExtensionContext) {
  return deckComposite.buildCompositeFactory(
    buildLinesBatchOnly,
    () => ({
      running: snapshot(),
      selectedKey: nav?.selectedKey(),
      showHint: !nav?.isActive() && entries.size > 0,
    }),
    getDeckMaxRows(),
  );
}

/** #607 d3. Route a confirmed row to the steer prompt. */
async function onRowConfirm(ctx: ExtensionContext, key: string): Promise<void> {
  const entry = entries.get(key);
  if (!entry) return;
  const text = await ctx.ui.editor(
    `Steer ${entry.label}`,
    deckComposite.buildSteerPrompt(entry, Date.now()),
  );
  if (text === undefined) return;
  steerDeckEntry(ctx.ui, key, text);
}

/** Deliver a steer to a deck row's job (`deck-ui` source; routes through the shared steer core). */
export function steerDeckEntry(ctx: ExtensionUIContext, key: string, message: string): void {
  void steerFromDeck(ctx, key, message);
}

// =============================================================================
// Row rendering
// =============================================================================

/** Top-level deck rows: batch headers + standalone (non-batched) entries,
 *  in insertion order. Batched members are NOT included — they render as
 *  their own per-job rows in the composite's row projection (#834), so
 *  including them here would double-render them. It is a strict superset
 *  of `buildLinesBatchOnly`'s output (both contain batch headers; this
 *  adds standalone rows).
 *
 *  Orphan-member contract (fail-open, deliberate): an entry whose `batchKey`
 *  names a batch that was never registered — or was cleared while its members
 *  were still alive — is classified here as standalone and renders as a
 *  top-level row. This is NOT logged, and if the batch is later (re)registered
 *  the same entry silently flips back to a batch member. Test
 *  test-dispatch-deck.ts block 8 pins this behaviour; treat it as the
 *  documented contract, not a bug. */
export function buildLines(now: number = Date.now()): string[] {
  const standalone: DeckEntry[] = [];
  for (const e of entries.values()) {
    if (!e.batchKey || !batches.has(e.batchKey)) {
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
    } else {
      lines.push(formatRow(item.e, now));
    }
  }
  return lines;
}

/** The composite's Text projection: batch header rows only.
 *  Members have their own per-job rows (one Text row per running entry
 *  in the composite, #834), so including them here would render each
 *  batch member twice. This is a strict subset of `buildLines`' output
 *  (both contain batch headers; `buildLines` also adds standalone rows).
 *  Exported for the superset-invariant test (test-dispatch-deck.ts block
 *  12c), which compares it against `buildLines` at a fixed `now` — the
 *  test cannot reconstruct this from the exported surface without
 *  sampling `Date.now()` twice and racing a 1 ms elapsed-time tick
 *  (flaky on CI). */
export function buildLinesBatchOnly(now: number = Date.now()): string[] {
  const lines: string[] = [];
  for (const b of batches.values()) {
    lines.push(formatBatchRow(b, now));
  }
  return lines;
}

const STALE_THRESHOLD_MS = (() => {
  const env = Number(process.env.PI_ENSEMBLE_STALE_THRESHOLD_MS);
  return Number.isFinite(env) && env >= 1000 ? env : 15 * 60_000;
})();

const HINT_MAX = 50;

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

export function formatBatchRow(
  batch: { label: string; size: number; completed: number; startedAt: number },
  now: number = Date.now(),
): string {
  const running = Math.max(0, batch.size - batch.completed);
  return `⏳ batch[${batch.label}] ${formatElapsed(Math.max(0, now - batch.startedAt))} · ${batch.completed}/${batch.size} done${running > 0 ? ` · ${running} running` : ""}`;
}
