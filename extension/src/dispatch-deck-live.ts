/**
 * Live view of a running subagent's activity (#839, epic #833 G5).
 *
 * The deck's transcript viewer (#607 d2) only reads the transcript file
 * written when a child settles — while a child runs, its row shows one
 * status line and nothing more. This module owns the per-job ring buffer of
 * RECENT ACTIVITY that the live-view overlay renders:
 *
 *   - `startBuffer(key)` / `dropBuffer(key)` — buffer lifecycle. Fed via
 *     `feedRawEvent` from a raw-event observer on `spawnSpecialist`'s opts
 *     (spawn.ts line handler, for every assistant `message_end` and
 *     `toolResult`), threaded through `WorkHooks` in `startJob`/`startBatch`.
 *     Buffers are dropped when the job's deck entry is cleared (the deck
 *     module's `clearEntry` calls `releaseOnEntryClear`) — with ONE
 *     exception: while the job's live view is OPEN, the entry's clear
 *     remembers that and keeps the buffer; `markViewClosed` then drops it.
 *     A job whose view was never open still drops its buffer at clear — no
 *     leak across many dispatches.
 *   - Events are stored UNTRUNCATED at feed time (#916): the only bound is
 *     the per-job bound (`LIVE_BUFFER_MAX_CHARS`, measured on the stored
 *     RAW text length, bounded queue — the newest-arriving events that do
 *     not fit are evicted; a single event larger than the bound is kept
 *     ALONE and untruncated).
 *     Stored text is still sanitised (control chars / ANSI stripped,
 *     newlines collapsed to the ` ⏎ ` separator) — only the LENGTH
 *     truncation was removed.
 *   - `markSettled(key, status)` / `getStatus(key)` record the settle
 *     outcome (async-jobs.ts calls `markSettled` at the same sites as
 *     `clearEntry`); the view header will read it in #916 slice B.
 *   - `onBufferAppend(key, cb)` (unsubscribe returned) notifies subscribers
 *     after an event is appended — the overlay uses it to re-render
 *     immediately (`openLiveView` subscribes on open, unsubscribes on
 *     close), while the deck's 1 s ticker also re-renders the focused
 *     overlay (idempotent — the same buffer, re-read).
 *   - `createAgentViewComponent` builds the overlay component (returned
 *     DIRECTLY from the `ctx.ui.custom` factory — never Container-
 *     wrapped, #176). The full-screen view (slice B) renders the
 *     untruncated buffer in full, wrapped to the render width; the
 *     component re-reads the buffer on every render, so new events appear
 *     on the next render without re-creating the component (appends
 *     trigger a re-render via onBufferAppend, and the deck's 1 s ticker
 *     re-renders too — idempotent).
 *
 * Quiet mode (`PI_ENSEMBLE_QUIET_STATUS=1`): `startBuffer` creates the
 * buffer regardless (#914 gate relocation — the early return that lived
 * here is removed; quiet mode now only suppresses the PASSIVE deck widget,
 * so a quiet session's rows still open the live view via the agent list /
 * roster). The widget suppression in dispatch-deck.ts `renderNow` is the
 * quiet gate that KEPT.
 *
 * The shared ring-buffer state (LiveEvent, the buffers map, the per-key
 * running sizes, `LIVE_BUFFER_MAX_CHARS`, the append subscribers) lives in
 * dispatch-deck-live-state.ts, shared with the feed path — the re-exports
 * below keep every existing import path working unchanged.
 *
 * Out of scope: /runs integration (#836); pause/skip/retry controls;
 * lens-review and adversarial children, which own their deck entries
 * directly and get no buffer (their rows offer steer only).
 */

import { sanitizeForStorage, sanitizeText } from "./dispatch-deck-line.ts";
import { trimToBound } from "./dispatch-deck-live-feed.ts";
import type { LiveEvent } from "./dispatch-deck-live-state.ts";
import {
  LIVE_BUFFER_MAX_CHARS,
  appendSubscribers,
  bufferSizes,
  buffers,
  eventSize,
  notifyAppend,
} from "./dispatch-deck-live-state.ts";
import { clearViewScroll } from "./dispatch-deck-live-view-component.ts";

// #1032 — the feed path (feedRawEvent / pushEvent) moved to
// dispatch-deck-live-feed.ts when this file hit the 500-line cap; the
// re-exports below keep the existing import paths working unchanged.
export { feedRawEvent, pushEvent } from "./dispatch-deck-live-feed.ts";

// #1032 — the shared ring-buffer state moved to
// dispatch-deck-live-state.ts (so the feed module and this one no longer
// import each other); the re-exports below keep the existing import paths
// working unchanged.
export {
  LIVE_BUFFER_MAX_CHARS,
  buffers,
  bufferSizes,
  eventSize,
  onBufferAppend,
  notifyAppend,
} from "./dispatch-deck-live-state.ts";
export type { LiveEvent } from "./dispatch-deck-live-state.ts";

// =============================================================================
// Ring buffer
// =============================================================================

/**
 * The live-view theme — the component receives it from the caller
 * (dispatch-deck-live-view.ts builds it from the pi-tui theme).
 */
export interface LiveViewTheme {
  /** Muted colour for header/hint/error-marker text. */
  muted: (t: string) => string;
  /** Error colour for error-marked tool results. */
  error: (t: string) => string;
}

// #916 — the overlay component and the open/close loop moved to
// dispatch-deck-live-view.ts when this file hit the 500-line cap; the
// re-exports below keep the existing import paths working unchanged.
export {
  createAgentViewComponent,
  getViewScrollState,
  openLiveView,
} from "./dispatch-deck-live-view.ts";

// =============================================================================
// Feed path
// =============================================================================

// =============================================================================
// Append notifications (#916)
// =============================================================================

/** The settle outcome recorded for the header (async-jobs calls markSettled). */
export type SettleStatus = "running" | "finished" | "failed" | "killed";

/** Settle outcomes recorded by markSettled (read by the view header). */
const settledStatuses = new Map<string, SettleStatus>();

/** True while the job's live view overlay is open (buffer survives clearEntry). */
const viewsOpen = new Set<string>();

/** True while the deck entry has been cleared but the view is still open. */
const entryCleared = new Set<string>();

/**
 * The buffer contents (a copy — the caller may mutate the array).
 */
export function getBuffer(key: string): LiveEvent[] {
  return [...(buffers.get(key) ?? [])];
}

/**
 * #915 — record an operator steer sent from the agent view's input line
 * as an `operatorSteer` event, so the view's transcript shows
 * `you → <label>: <text>` in order with the child's own events.
 *
 * The label is taken at call time (the deck entry's label while the job is
 * running; the caller passes a fallback for a settled job) and is sanitised
 * here — labels flow from untrusted child output, and the rendered line
 * must never desync the overlay. The steer text is stored UNTRUNCATED
 * (the echo is operator input, exempt from the child-truncation limits —
 * only the per-job byte bound applies) but with newlines collapsed to the
 * ` ⏎ ` separator, so the echo renders as one wrapped logical line like
 * every other text event. Sanitisation is idempotent.
 *
 * The push goes through the SAME bound as feedRawEvent (LIVE_BUFFER_MAX_CHARS
 * — `trimToBound` evicts oldest-first) and triggers the SAME append
 * subscribers (`onBufferAppend`), so the open view re-renders immediately.
 * A key with no buffer (view closed, job long settled) is a no-op — there
 * is no surface left to show the echo on.
 */
export function appendOperatorSteer(key: string, label: string, text: string): void {
  const buf = buffers.get(key);
  if (!buf) return;
  const ev: LiveEvent = {
    kind: "operatorSteer",
    label: sanitizeText(label),
    text: sanitizeForStorage(text),
    at: Date.now(),
  };
  buf.push(ev);
  // Same bookkeeping as pushEvent: the running total is maintained per key
  // so trimToBound never re-sums the buffer (it evicts oldest-first within
  // the per-job LIVE_BUFFER_MAX_CHARS bound).
  bufferSizes.set(key, (bufferSizes.get(key) ?? 0) + eventSize(ev));
  trimToBound(key, buf);
  notifyAppend(key);
}

/**
 * The newest `n` events of a buffer without copying the whole ring (the
 * overlay renders on the deck's 1 s cadence; copying the full buffer per
 * tick is wasted work when it only reads a 24-line window). `getBuffer`
 * stays for tests.
 */
export function getBufferTail(key: string, n: number): LiveEvent[] {
  const buf = buffers.get(key);
  if (!buf) return [];
  const start = Math.max(0, buf.length - n);
  return buf.slice(start);
}

/** Buffer count for leak assertions (tests). */
export function bufferCount(): number {
  return buffers.size;
}

/**
 * Create (or return) the per-job ring buffer.
 *
 * #914 quiet-mode gate relocation: the `PI_ENSEMBLE_QUIET_STATUS` early
 * return that lived here is REMOVED — buffers are ALWAYS created, because
 * quiet mode now only suppresses the PASSIVE deck widget (renderNow's
 * empty-deck guard in dispatch-deck.ts); the agent list / roster still
 * open the live view for a quiet session's rows. This is the quiet gate
 * that CHANGED; the widget suppression in dispatch-deck.ts is the one
 * that KEPT.
 */
export function startBuffer(key: string): void {
  if (!buffers.has(key)) buffers.set(key, []);
}

/**
 * Drop the per-job ring buffer (called when the job's deck entry clears,
 * when a view closes over an already-cleared entry, and by tests). Clears
 * the key's subscribers (then deletes the set) plus its entryCleared and
 * viewOpen state so no per-key bookkeeping outlives the buffer.
 */
export function dropBuffer(key: string): void {
  buffers.delete(key);
  const subs = appendSubscribers.get(key);
  if (subs) {
    subs.clear();
    appendSubscribers.delete(key);
  }
  entryCleared.delete(key);
  settledStatuses.delete(key);
  viewsOpen.delete(key);
  bufferSizes.delete(key);
  // #916 SLICE B — clear the job's persisted scroll/follow state (the
  // view component's module-level Map) so no per-key view state outlives
  // the buffer (the small exported hook the brief calls for).
  clearViewScroll(key);
}

/** True when a live-view buffer exists for the key (gate for the row action). */
export function hasBuffer(key: string): boolean {
  return buffers.has(key);
}

// =============================================================================
// Settle status (#916)
// =============================================================================

/**
 * Record the job's settle outcome, called from the async-jobs settle sites
 * alongside `clearEntry` (success → "finished", error → "failed",
 * kill/abort → "killed"). The view header will read it via `getStatus`
 * in #916 slice B.
 */
export function markSettled(key: string, status: Exclude<SettleStatus, "running">): void {
  settledStatuses.set(key, status);
}
// Consumer: the #916 slice-B view header (not yet wired).
/** The recorded status for the key — "running" until markSettled. */
export function getStatus(key: string): SettleStatus {
  return settledStatuses.get(key) ?? "running";
}

// =============================================================================
// View-open bookkeeping (#916)
// =============================================================================

/** The live view for the key is open (markViewOpen / markViewClosed). */
export function isViewOpen(key: string): boolean {
  return viewsOpen.has(key);
}

/**
 * Mark the job's live view as open — while open, `clearEntry` (job settle)
 * must NOT drop the buffer; the view keeps reading it until close.
 */
export function markViewOpen(key: string): void {
  viewsOpen.add(key);
}

/**
 * Mark the job's live view as closed. Drops the buffer iff the deck entry
 * was ALREADY cleared while the view was open (the entryCleared fact, set
 * by `releaseOnEntryClear`) — otherwise the entry is still alive, the
 * buffer is still owned by the entry's lifecycle, and only viewOpen is
 * cleared.
 */
export function markViewClosed(key: string): void {
  viewsOpen.delete(key);
  if (entryCleared.has(key)) dropBuffer(key);
}

/**
 * The deck module's `clearEntry` calls this in place of its conditional
 * drop: if the view is open, remember that the entry cleared (the buffer
 * is kept for the view; `markViewClosed` drops it then); otherwise drop
 * the buffer now. The live module owns the keep/drop fact — no snapshot
 * of the deck's entries is needed to ask whether one entry is gone.
 */
export function releaseOnEntryClear(key: string): void {
  if (viewsOpen.has(key)) entryCleared.add(key);
  else dropBuffer(key);
}
