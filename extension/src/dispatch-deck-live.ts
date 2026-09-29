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
 *     module's `clearEntry` calls `dropBuffer` — co-located lifecycle, no
 *     leak across many dispatches).
 *   - Events are stored UNTRUNCATED at feed time (#916): the only bound is
 *     the per-job byte cap (`LIVE_BUFFER_MAX_BYTES`, measured on the stored
 *     RAW text length, bounded queue — the newest-arriving events that do
 *     not fit are evicted; a single event larger than the bound is kept
 *     ALONE and untruncated).
 *     Stored text is still sanitised (control chars / ANSI stripped,
 *     newlines collapsed to the ` ⏎ ` separator) — only the LENGTH
 *     truncation was removed.
 *   - `markSettled(key, status)` / `getStatus(key)` record the settle
 *     outcome (async-jobs.ts calls `markSettled` at the same sites as
 *     `clearEntry`); the header reads it.
 *   - `onBufferAppend(key, cb)` (unsubscribe returned) notifies subscribers
 *     after an event is appended — the overlay uses it to re-render instead
 *     of relying on the deck's 1 s ticker (#916 PM decision).
 *   - `createLiveViewComponent` builds the overlay component (returned
 *     DIRECTLY from the `ctx.ui.custom` factory — never Container-wrapped,
 *     #176). The component re-reads the buffer on every render, so new
 *     events appear on the next render without re-creating the component.
 *     Each event still renders as ONE line, width-bounded via
 *     `toTerminalLine` (slice B rewrites the view with real wrapping).
 *
 * Quiet mode (`PI_ENSEMBLE_QUIET_STATUS=1`): `startBuffer` creates the
 * buffer regardless (#914 gate relocation — the early return that lived
 * here is removed; quiet mode now only suppresses the PASSIVE deck widget,
 * so a quiet session's rows still open the live view via the agent list /
 * roster). The widget suppression in dispatch-deck.ts `renderNow` is the
 * quiet gate that KEPT.
 *
 * Out of scope: /runs integration (#836); pause/skip/retry controls;
 * lens-review and adversarial children, which own their deck entries
 * directly and get no buffer (their rows offer steer only).
 */

import { NEWLINE_SEP, sanitizeText } from "./dispatch-deck-line.ts";
import { snapshot as deckSnapshot } from "./dispatch-deck.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { trace } from "./trace.ts";

// #916 — the overlay component and the open/close loop moved to
// dispatch-deck-live-view.ts when this file hit the 500-line cap; the
// re-exports below keep the existing import paths working unchanged.
export {
  createLiveViewComponent,
  openLiveView,
  type LiveViewHeader,
  type LiveViewTheme,
  type LiveViewHost,
} from "./dispatch-deck-live-view.ts";

// =============================================================================
// Ring buffer
// =============================================================================

/**
 * A normalised unit of a child's recent activity.
 *
 * The stored strings are sanitised at FEED time (issue #927): every
 * `text` / `args` / `name` field is control-char/ANSI-stripped, with
 * newlines collapsed to the ` ⏎ ` separator (dispatch-deck-line.ts
 * `NEWLINE_SEP`) — but UNTRUNCATED (#916). Renderers must still
 * width-bound via `toTerminalLine`, but must not assume raw newlines or
 * control characters here.
 *
 * `thinking` blocks (`{kind:"thinking"}`) are stored with their raw
 * character count as `text` (#916: the view renders `▸ thinking (N chars)`
 * with N = raw char count, not the post-wrap rendered size).
 */
export type LiveEvent =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; name: string; args: string }
  | { kind: "toolResult"; name: string; text: string; isError: boolean }
  | { kind: "thinking"; text: string };

/**
 * The per-job byte cap, measured on the stored RAW text length (the
 * `.text` field for text/thinking, the full JSON string for toolCall
 * args) — #916, replacing the 200-event ring cap and the feed-time
 * character truncation. The buffer behaves as a bounded queue: when the
 * total exceeds the bound, the newest-arriving events that do not fit are
 * evicted. A single event whose own size exceeds the bound is kept ALONE
 * and untruncated (the bound caps the TOTAL across multiple events, never
 * a lone event — PM decision, #916).
 */
export const LIVE_BUFFER_MAX_BYTES = 512 * 1024;

/** The settle outcome recorded for the header (async-jobs calls markSettled). */
export type SettleStatus = "running" | "finished" | "failed" | "killed";

// Exported for the quiet-mode gate test (agent-list.ts block 8) — the
// buffer map is the load-bearing fact the test reads to prove the
// `startBuffer` gate moved (a quiet session's buffer IS created).
export const buffers = new Map<string, LiveEvent[]>();

/** Settle outcomes recorded by markSettled (read by the view header). */
const settledStatuses = new Map<string, SettleStatus>();

/** True while the job's live view overlay is open (buffer survives clearEntry). */
const viewsOpen = new Set<string>();

/** Append subscribers per key (#916: the overlay re-renders on feed). */
const appendSubscribers = new Map<string, Set<() => void>>();

/** The raw stored size of one event, in characters of the stored text. */
function eventSize(ev: LiveEvent): number {
  switch (ev.kind) {
    case "text":
      return ev.text.length;
    case "toolCall":
      return ev.args.length;
    case "toolResult":
      return ev.text.length;
    case "thinking":
      return ev.text.length;
  }
}

/**
 * The buffer contents (a copy — the caller may mutate the array).
 */
export function getBuffer(key: string): LiveEvent[] {
  return [...(buffers.get(key) ?? [])];
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

/** Drop the per-job ring buffer (called when the job's deck entry clears). */
export function dropBuffer(key: string): void {
  buffers.delete(key);
  settledStatuses.delete(key);
  viewsOpen.delete(key);
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
 * kill/abort → "killed"). The view header reads it via `getStatus`.
 */
export function markSettled(key: string, status: Exclude<SettleStatus, "running">): void {
  settledStatuses.set(key, status);
}

/** The recorded status for the key — "running" until markSettled. */
export function getStatus(key: string): SettleStatus {
  return settledStatuses.get(key) ?? "running";
}

// =============================================================================
// Append notifications (#916)
// =============================================================================

/**
 * Subscribe to appends for the key's buffer. Returns an unsubscribe.
 * `cb` is invoked AFTER the event is stored; a throwing subscriber is
 * caught and traced (it can never break the feed path).
 */
export function onBufferAppend(key: string, cb: () => void): () => void {
  let subs = appendSubscribers.get(key);
  if (!subs) {
    subs = new Set();
    appendSubscribers.set(key, subs);
  }
  subs.add(cb);
  return () => {
    subs.delete(cb);
    if (subs.size === 0) appendSubscribers.delete(key);
  };
}

/** Notify the key's append subscribers (called from feedRawEvent). */
function notifyAppend(key: string): void {
  const subs = appendSubscribers.get(key);
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb();
    } catch (err) {
      trace(
        `dispatch-deck-live: onBufferAppend subscriber threw for ${key}: ${(err as Error).message}`,
      );
    }
  }
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
 * Mark the job's live view as closed. If the job has already settled
 * (its deck entry is cleared, so `hasBuffer` alone can't tell us — the
 * deck module's clearEntry held the buffer because the view was open),
 * drop the buffer now: it has outlived both its entry and its view.
 */
export function markViewClosed(key: string): void {
  viewsOpen.delete(key);
  if (!hasEntry(key)) dropBuffer(key);
}

/**
 * Has the job's deck entry already been cleared? The deck module owns the
 * map; this module can only observe via the deck's `snapshot` export.
 */
function hasEntry(key: string): boolean {
  return deckSnapshot().some((e) => e.key === key);
}

// =============================================================================
// Feed path
// =============================================================================

/**
 * Feed one parsed child event into the job's ring buffer. Events the
 * overlay cannot show (non-assistant / non-toolResult messages, empty
 * content) are dropped silently. A feed for a key with no buffer (quiet
 * mode, or a lens/adversarial child) is a no-op.
 */
export function feedRawEvent(key: string, event: PiJsonEvent): void {
  const buf = buffers.get(key);
  if (!buf) return;
  const added = pushEvent(buf, event);
  if (added) notifyAppend(key);
}

/**
 * Push a parsed event onto a buffer (module helper, exported for the
 * feed-path test). Returns true when at least one event was stored.
 *
 * Storage is UNTRUNCATED (#916): the only bound is the per-job byte cap
 * (`LIVE_BUFFER_MAX_BYTES`), enforced AFTER the push by evicting oldest
 * events first. Sanitisation (control chars, ANSI, newline collapse) is
 * kept — only the length truncation was removed.
 */
export function pushEvent(buf: LiveEvent[], event: PiJsonEvent): boolean {
  if (event.type !== "message" && event.type !== "message_end") return false;
  const msg = event.message;
  if (!msg) return false;
  let added = false;
  if (msg.role === "toolResult") {
    const resultText = (msg.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0)
      .map((b) => b.text as string)
      .join("");
    if (!resultText) return false;
    // #839 — the tool-result identity fields live on the MESSAGE (pi-ai
    // `ToolResultMessage`), not on the event; no cast needed. The result
    // text is untrusted child output — sanitise + collapse to ONE logical
    // line at feed time (newlines → the ` ⏎ ` separator, C0/ANSI stripped,
    // tabs → spaces) so the overlay can never desync pi-tui's line
    // accounting (issue #927: raw newlines / control chars from tool
    // results ghosted the overlay over the main chat and polluted the
    // scrollback on every 1 s re-render).
    const name = msg.toolName;
    buf.push({
      kind: "toolResult",
      name: name ? sanitizeText(name) : "unknown",
      text: sanitizeText(resultText).replace(/\n+/g, NEWLINE_SEP),
      isError: msg.isError === true,
    });
    added = true;
    return trimToBound(buf);
  }
  if (msg.role !== "assistant") return false;
  for (const block of msg.content ?? []) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      buf.push({
        kind: "text",
        text: sanitizeText(block.text).replace(/\n+/g, NEWLINE_SEP),
      });
      added = true;
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.length > 0
    ) {
      // #916 — thinking blocks were silently dropped before; store them as
      // their own variant so the view can render `▸ thinking (N chars)`.
      buf.push({
        kind: "thinking",
        text: sanitizeText(block.thinking).replace(/\n+/g, NEWLINE_SEP),
      });
      added = true;
    } else if (block.type === "toolCall" && block.name) {
      // #916 — store the FULL JSON of the arguments (previously the 50-char
      // extractToolHint preview); the view renders it in full.
      buf.push({
        kind: "toolCall",
        name: sanitizeText(block.name),
        args: JSON.stringify(block.arguments ?? ""),
      });
      added = true;
    }
  }
  if (added) trimToBound(buf);
  return added;
}

/**
 * Enforce the per-job byte bound AFTER a push: evict NEWEST-first (the just-
 * pushed event and everything younger) until the total stored RAW text
 * length is within `LIVE_BUFFER_MAX_BYTES`. A single event larger than the
 * bound is kept ALONE (evicting older events cannot bring the total under
 * the bound, and evicting it would empty the buffer — the bound caps the
 * TOTAL across events, never a lone event). Keeping the newest-arrived as
 * the survivor makes the buffer behave like a bounded queue (like the old
 * ring, which kept the newest N) and means a >512 KB event — a large file
 * read — does not permanently displace the rest of the buffer's history:
 * the next small event evicts it.
 */
function trimToBound(buf: LiveEvent[]): boolean {
  let total = 0;
  for (const ev of buf) total += eventSize(ev);
  if (total <= LIVE_BUFFER_MAX_BYTES) return buf.length > 0;
  // Evict newest-first, but never evict down to zero events — a lone
  // oversized event is retained alone (see above).
  while (total > LIVE_BUFFER_MAX_BYTES && buf.length > 1) {
    const newest = buf.pop();
    if (newest) total -= eventSize(newest);
  }
  return buf.length > 0;
}
