/**
 * Live dispatch deck (#117 / #607 / #709 / #729 / #742 / #834 / #839).
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
 * with an activity buffer opens the live view (#839), otherwise it opens
 * the steer prompt (`deck-ui` source tag).
 *
 * Opt-out: PI_ENSEMBLE_QUIET_STATUS=1 (see dispatch-deck-quiet.ts).
 *
 * #709's "do not remove either widget" directive is superseded — the
 * aboveEditor `ensemble:deck-prompt` widget was the source of the
 * duplicate projection and was removed in #729.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { buildAgentListLines } from "./agent-list.ts";
import * as deckComposite from "./dispatch-deck-composite.ts";
import { type RowConfirmHost, onRowConfirm } from "./dispatch-deck-confirm.ts";
import { steerFromDeck } from "./dispatch-deck-interactive.ts";
import { dropBuffer } from "./dispatch-deck-live.ts";
import { type DeckNav, createDeckNav } from "./dispatch-deck-nav.ts";
import {
  _clearNavUnsub,
  _getNavUnsub,
  _getWidgetVisible,
  _setWidgetVisible,
  registerNavListener,
  suppressWidgetIfQuiet,
} from "./dispatch-deck-quiet.ts";
import {
  buildLinesBatchOnly as buildLinesBatchOnlyImpl,
  buildLines as buildLinesImpl,
} from "./dispatch-deck-rows.ts";
import { type RunningState, emptyRunningState } from "./progress.ts";
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

/** Test seam: override the focus probe's focused-component read. */
export function setFocusedComponentProbe(probe: (() => unknown) | undefined): void {
  focusedComponentProbe = probe;
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
// The widget's visibility flag moved to dispatch-deck-quiet.ts (#914 —
// the empty-deck guard + setWidget call moved there with it, so the flag
// and the call stay in lockstep; dispatch-deck.ts reads it via
// _getWidgetVisible / writes via _setWidgetVisible).
let nav: DeckNav | undefined;
// TUI captured from the deck widget factory at render time — module scope
// so the focus probe survives re-attach (a re-attach builds a fresh DeckNav
// but the TUI is the same instance for the lifetime of the interactive
// session; see buildDeckWidgetFactory). Cleared on detach so a stale TUI
// from a previous session (or test) does not leak into the focus probe.
let deckTui: TUI | null = null;
// The focused-component probe seam the tests exercise (identity of the
// focused component, `tui.focusedComponent`); see setFocusedComponentProbe.
let focusedComponentProbe: (() => unknown) | undefined;
// Self-heal attempt counter: caps the renderNow retry loop so a persistent
// onTerminalInput failure (a host without the capability at all) doesn't
// re-create and re-attempt registration on every 1 s render for the whole
// session. Reset ONLY by attachNav — the self-heal path must ACCUMULATE
// attempts across renders or the cap never binds.
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
  if (activeCtx && _getWidgetVisible()) {
    try {
      activeCtx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {}
  }
  detachNav();
  deckTui = null; // clear the focus-probe TUI capture
  activeCtx = undefined;
  entries.clear();
  batches.clear();
  pendingRender = false;
  _setWidgetVisible(false);
}

/** Detach the roster-mode listener (if registered) and drop the nav state. */
function detachNav(): void {
  const unsub = _getNavUnsub();
  if (unsub) {
    try {
      unsub();
    } catch {}
  }
  _clearNavUnsub();
  nav = undefined;
}

function navGetters(ctx: ExtensionContext) {
  return {
    runningKeys: () => [...entries.values()].map((e) => e.key),
    // No try/catch: a throw propagates to the key-press handler (Pi's
    // input loop). Swallowing it to "" would ENABLE roster mode from a
    // throwing editor — fail open instead.
    editorText: () => ctx.ui.getEditorText(),
    // Focus gate for the roster nav (#deck-nav-focus): the global
    // onTerminalInput listener runs BEFORE pi-tui routes the key to the
    // focused component, so without this the roster would steal `↓` from
    // the /model selector, ctx.ui.* dialogs and overlays (their editor
    // text is empty while they have focus). True ONLY when the main
    // editor is focused.
    editorFocused: () => editorFocused(),
  };
}

/**
 * Exact focus check for the roster nav. Reads `tui.focusedComponent`
 * (private on pi-tui's TuiBase, duck-typed here) and reads the editor
 * component's `focused` flag (pi-tui's TuiBase.setFocus toggles it on
 * every focusable component on focus change). True only when the TUI
 * says the editor is focused AND the editor's own flag agrees.
 *
 * Fail-closed: an absent TUI (no deck render has run yet), a missing
 * `focusedComponent`/`focused` shape (a host without the probe surface),
 * or a THROWING read all report `false` — the roster never activates
 * when focus cannot be proven to be on the editor, rather than guessing
 * `null` (degraded) and re-stealing keys from other components.
 */
function editorFocused(): boolean {
  try {
    if (!deckTui) return false;
    const tui = deckTui as unknown as { focusedComponent?: unknown };
    const focused = focusedComponentProbe ? focusedComponentProbe() : tui.focusedComponent;
    if (!focused || typeof focused !== "object") return false;
    const flag = (focused as { focused?: unknown }).focused;
    return flag === true;
  } catch {
    trace("dispatch-deck: editorFocused probe threw — treating as not focused");
    return false;
  }
}

/**
 * #834 — register the roster-mode input listener once. The listener is
 * the operator's path into the deck's running-job rows: from an empty
 * editor, `down` enters roster mode (see dispatch-deck-nav.ts). It is
 * registered only when the extension has a UI surface and the deck is
 * not quiet — quiet mode and headless mode register nothing. `detach()`
 * unsubscribes; a re-`attach` after `detach` registers a fresh listener
 * (the module-level `nav` is cleared by `detach`, so at most one
 * listener is ever live). #914 — the global shortcut (agent-list-keys.ts)
 * is the quiet-mode entry point; this roster listener stays quiet-gated,
 * so a quiet session's hidden roster cannot capture `↓`.
 */
function attachNav(ctx: ExtensionContext): void {
  if (!tryAttachNav(ctx)) detachNav();
}

/**
 * Own the nav wiring for one cycle: the quiet/hasUI guards, the
 * prior-listener teardown, the createDeckNav construction and the
 * registration. Used by `attach()` (explicit attach — a new budget for
 * the self-heal counters) and renderNow's self-heal (a transient
 * attach-time failure retries here on a later render). The
 * `navWarned`/`navHealAttempts` resets live in `attachNav` only: the
 * self-heal path must accumulate across renders so the cap binds. Returns
 * true when the listener is live.
 */
function tryAttachNav(ctx: ExtensionContext): boolean {
  if (isQuiet() || !ctx.hasUI) return false;
  // Unsubscribe any prior listener before re-registering (attach can be
  // called more than once in a session without an intervening detach).
  detachNav();
  const n = createDeckNav(
    navGetters(ctx),
    (key) => void onRowConfirm(ctx, key, rowConfirmHostFor(ctx)),
    scheduleRender,
  );
  if (!registerNavListener(n, ctx)) return false;
  nav = n;
  return true;
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
  // #839 — the live-view ring buffer's lifecycle is co-located with the deck
  // entry's: clearing the entry always drops the buffer (no-op for keys with
  // none — lens/adversarial children and skipDeck jobs get no buffer at all).
  dropBuffer(key);
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
  _setWidgetVisible(false);
  deckTui = null; // clear the focus-probe TUI capture
  detachNav();
}

export function isTicking(): boolean {
  return tickHandle !== undefined;
}

// #839 — the steer host is built per-attach (onRowConfirm receives it at call
// time) so a steer is never silently dropped: openSteerPrompt / openLiveView
// pass the SAME ctx.ui down, so steerFromDeck always has a UI to notify on
// failure.
function rowConfirmHostFor(ctx: ExtensionContext): RowConfirmHost {
  return {
    getEntry: (key) => entries.get(key),
    steer: (key, message) => void steerFromDeck(ctx.ui, key, message),
  };
}

/** #914 — route an agent-list Enter on a job row through the deck's
 *  unchanged confirm route (buffer → live view, else steer prompt). */
export function confirmRow(ctx: ExtensionContext, key: string): Promise<void> {
  return onRowConfirm(ctx, key, rowConfirmHostFor(ctx));
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
  // #914 — quiet mode suppresses ONLY the passive widget (roster listener
  // quiet-gated in tryAttachNav, global shortcut stays live); a widget left
  // visible from a pre-quiet render is dropped (dispatch-deck-quiet.ts).
  // The empty-deck guard and the widget set are the same seam — they live
  // in dispatch-deck-quiet.ts (setDeckWidget) to keep this module within
  // the 500-line limit.
  if (suppressWidgetIfQuiet(activeCtx, WIDGET_KEY, _getWidgetVisible, _setWidgetVisible)) {
    return;
  }
  if (entries.size === 0 && batches.size === 0) {
    if (_getWidgetVisible()) {
      try {
        activeCtx.ui.setWidget(WIDGET_KEY, undefined);
      } catch {}
      _setWidgetVisible(false);
    }
    return;
  }
  // Self-heal a transient attach-time onTerminalInput failure: re-try the
  // roster-mode listener registration while it is absent, capped so a
  // persistent failure (a host without the capability at all) settles into
  // the degraded state instead of retrying every render forever. The
  // quiet/hasUI guards live inside tryAttachNav. The attempt counter is
  // NOT reset here — the self-heal path accumulates across renders so the
  // NAV_HEAL_MAX cap binds; only attachNav resets the budget.
  if (nav === undefined && navHealAttempts < NAV_HEAL_MAX) {
    navHealAttempts++;
    if (tryAttachNav(activeCtx)) {
      trace("dispatch-deck: roster-mode nav restored (self-heal) after earlier failure");
    }
  }
  const factory = buildDeckWidgetFactory(activeCtx);
  try {
    activeCtx.ui.setWidget(WIDGET_KEY, factory, { placement: "belowEditor" });
    _setWidgetVisible(true);
  } catch (err) {
    trace(`dispatch-deck: setWidget failed: ${(err as Error).message}`);
  }
}

/** The deck widget factory wraps the composite factory to capture the TUI
 *  instance (the only TUI an extension legitimately reaches — the deck's
 *  `setWidget` factory receives it as its first argument). The wrapper is
 *  created once per render; the inner composite is built fresh each call. */
function buildDeckWidgetFactory(ctx: ExtensionContext) {
  const inner = buildCompositeWidgetFactory(ctx);
  return (tui: TUI, theme: Parameters<typeof inner>[1]) => {
    deckTui = tui; // focus probe (editorFocused) reads it via duck-typing
    return inner(tui, theme);
  };
}

/** Build the single composite widget factory (batch rows + per-job plain
 *  rows). The Text projection reads `buildLinesBatchOnly` (batch headers
 *  only); the per-job rows are one Text row per RUNNING entry (batch
 *  members included, #834) with the roster-mode `>` marker and the
 *  agent-list hint (buildAgentListHint). renderNow's empty-deck guard
 *  tests `entries.size === 0 && batches.size === 0` directly (no
 *  projection read) so that a deck with only standalone entries still
 *  renders; `buildLines`' output is a strict superset of
 *  `buildLinesBatchOnly`'s (both contain batch headers; only `buildLines`
 *  adds standalone rows).
 *  #914 — the per-job rows ARE the agent-list projection
 *  (buildAgentListLines, the shared overlay/widget row layout), and the
 *  hint line is the agent-list hint (buildAgentListHint). */
function buildCompositeWidgetFactory(ctx: ExtensionContext) {
  return deckComposite.buildCompositeFactory(
    () => buildLinesBatchOnlyImpl(batches),
    () => ({
      running: snapshot(),
      selectedKey: nav?.selectedKey(),
      showHint: !nav?.isActive() && entries.size > 0,
    }),
    () => buildAgentListLines(snapshot(), [...batches.values()], getDeckMaxRows()),
    getDeckMaxRows(),
  );
}

// =============================================================================
// Row rendering (the row-shape code lives in dispatch-deck-rows.ts;
// these thin wrappers keep the module's public API stable while the deck
// module's private `entries`/`batches` maps stay module-private)
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
  return buildLinesImpl(entries, batches, now);
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
  return buildLinesBatchOnlyImpl(batches, now);
}

// Re-exported from dispatch-deck-rows.ts so that existing importers
// (dispatch-deck-composite.ts, test-dispatch-deck.ts) keep their import
// paths unchanged — the deck module stays the stable public surface for
// the row-shape API.
export { formatBatchRow, formatRow, formatAgentRow } from "./dispatch-deck-rows.ts";
