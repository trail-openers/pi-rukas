/**
 * Shared ring-buffer state for the live view's buffer path (#1032: pulled
 * out of dispatch-deck-live.ts when the feed path was split off to
 * dispatch-deck-live-feed.ts, so that module and dispatch-deck-live.ts no
 * longer import each other — both import THIS module instead, keeping the
 * dependency graph one-directional).
 *
 * The LiveEvent type, the buffers map, the per-key running sizes, the
 * per-job char bound, `eventSize`, and the append-subscriber machinery all
 * live here. dispatch-deck-live.ts re-exports everything from here, so
 * every existing import path (`from "./dispatch-deck-live.ts"`) keeps
 * working unchanged.
 */

import { trace } from "./trace.ts";

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
  | { kind: "thinking"; text: string }
  /**
   * #915 — an operator steer sent from the agent view's input line.
   * Distinct from the child's own events: rendered as
   * `you → <label>: <text>` so the conversation reads in order. Stored
   * UNTRUNCATED like every other event and counted within the per-job
   * byte bound.
   */
  | { kind: "operatorSteer"; label: string; text: string; at: number };

/**
 * The per-job bound, measured on the stored string length in UTF-16 code
 * units (the `.text` field for text/thinking, the full JSON string for
 * toolCall args) — #916, replacing the 200-event ring cap and the feed-time
 * character truncation. The buffer behaves as a bounded queue: when the
 * total exceeds the bound, the OLDEST events are evicted until the total
 * fits — the buffer keeps the most RECENT activity (that is what a live
 * view is for; eviction of the just-pushed event would freeze the view on
 * stale output once the bound is reached). A single event whose own size
 * exceeds the bound is kept ALONE and untruncated (the bound caps the
 * TOTAL across multiple events, never a lone event — PM decision, #916).
 */
export const LIVE_BUFFER_MAX_CHARS = 512 * 1024;

// Exported for the quiet-mode gate test (agent-list.ts block 8) — the
// buffer map is the load-bearing fact the test reads to prove the
// `startBuffer` gate moved (a quiet session's buffer IS created).
export const buffers = new Map<string, LiveEvent[]>();

/** Running stored size per buffer (key → sum of eventSize), kept in sync
 *  on push/evict so trimToBound never re-sums the buffer. */
// Exported (not private): dispatch-deck-live-feed.ts mutates the running
// total on push/evict so trimToBound never re-sums the buffer.
export const bufferSizes = new Map<string, number>();

/** The raw stored size of one event, in characters of the stored text. */
export function eventSize(ev: LiveEvent): number {
  switch (ev.kind) {
    case "text":
      return ev.text.length;
    case "toolCall":
      return ev.args.length;
    case "toolResult":
      return ev.text.length;
    case "thinking":
      return ev.text.length;
    case "operatorSteer":
      return ev.text.length;
  }
}

/** Append subscribers per key (#916: the overlay re-renders on feed). */
export const appendSubscribers = new Map<string, Set<() => void>>();

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
export function notifyAppend(key: string): void {
  const subs = appendSubscribers.get(key);
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb();
    } catch (err) {
      trace(
        `dispatch-deck-live-state: onBufferAppend subscriber threw for ${key}: ${(err as Error).message}`,
      );
    }
  }
}
