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
 *     RAW text length, oldest events evicted first). A single event larger
 *     than the bound is kept ALONE and untruncated (PM decision, #916).
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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { NEWLINE_SEP, sanitizeText, toTerminalLine } from "./dispatch-deck-line.ts";
import type { DeckEntry } from "./dispatch-deck.ts";
import { snapshot as deckSnapshot } from "./dispatch-deck.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { formatElapsed } from "./progress.ts";
import { trace } from "./trace.ts";

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
 * character truncation. Oldest events are evicted first; a single event
 * whose own size exceeds the bound is kept ALONE and untruncated (the
 * bound caps the TOTAL across multiple events, never a lone event).
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
      trace(`dispatch-deck-live: onBufferAppend subscriber threw for ${key}: ${(err as Error).message}`);
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
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
      // #916 — thinking blocks were silently dropped before; store them as
      // their own variant so the view can render `▸ thinking (N chars)`.
      buf.push({ kind: "thinking", text: sanitizeText(block.thinking).replace(/\n+/g, NEWLINE_SEP) });
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
 * Enforce the per-job byte bound AFTER a push: evict OLDEST events first
 * until the total stored RAW text length is within `LIVE_BUFFER_MAX_BYTES`.
 * A single event larger than the bound is kept ALONE (evicting it would
 * empty the buffer and the bound is on the TOTAL, not a per-event cap).
 */
function trimToBound(buf: LiveEvent[]): boolean {
  let total = 0;
  for (const ev of buf) total += eventSize(ev);
  if (total <= LIVE_BUFFER_MAX_BYTES) return buf.length > 0;
  // Evict oldest-first, but never evict down to zero events when the
  // remaining single event alone exceeds the bound (keep it alone).
  while (total > LIVE_BUFFER_MAX_BYTES && buf.length > 1) {
    const oldest = buf.shift();
    if (oldest) total -= eventSize(oldest);
  }
  return buf.length > 0;
}

// =============================================================================
// Overlay component
// =============================================================================

export interface LiveViewHeader {
  label: string;
  role: string;
  startedAt: number;
  /** Epoch ms (set by the caller on each render — the view is live). */
  now: number;
  turns: number;
  toolUses: number;
  totalTokens: number;
  lastToolName?: string;
}

export interface LiveViewTheme {
  /** Muted colour for header/hint/error-marker text. */
  muted: (t: string) => string;
  /** Error colour for error-marked tool results. */
  error: (t: string) => string;
}

// The deck's 1 s ticker (dispatch-deck.ts renderNow) re-registers its
// widget and calls requestRender on its 1 s cadence, which re-renders the
// focused component (this overlay) in the same TUI pass — that is the
// "new events appear on the next render" seam. The deck is the only
// scheduled renderer while a job runs, so the overlay re-reads the buffer
// on that cadence without owning its own timer. (Tests drive render() and
// handleInput() directly; a live check covers the cadence on the
// installed Pi, per the issue's AGENTS.md §4 note.)

/**
 * Render one buffer event as a single overlay line. Every piece of
 * UNTRUSTED content (assistant text, tool name, args, result) is
 * width-bounded to the row via `toTerminalLine` — render() must never
 * return a string containing a newline or wider than the overlay column
 * (pi-tui's differential renderer corrupts the terminal otherwise; see
 * dispatch-deck-line.ts). (#916: stored text is untruncated — the
 * one-line-per-event shape stays for now; slice B rewrites the view with
 * real wrapping.)
 */
function renderEvent(ev: LiveEvent, theme: LiveViewTheme, width: number): string {
  switch (ev.kind) {
    case "text":
      return toTerminalLine(ev.text, width);
    case "toolCall":
      return toTerminalLine(ev.args ? `→ ${ev.name} ${ev.args}` : `→ ${ev.name}`, width);
    case "toolResult": {
      // Sanitise + width-bound the plain text FIRST, then apply the theme
      // colour to the marker (issue #927: never colour before sanitising —
      // the marker only carries the tool name and the "error" literal).
      const safeText = toTerminalLine(ev.text, width);
      const marker = ev.isError
        ? `✗ ${toTerminalLine(ev.name, 40)} (error)`
        : `✓ ${toTerminalLine(ev.name, 40)}`;
      const head = ev.isError ? theme.error(marker) : marker;
      return safeText ? `${head} ${safeText}` : marker;
    }
    case "thinking":
      // #916 — collapsed form for now; N = raw stored char count.
      return toTerminalLine(`▸ thinking (${ev.text.length} chars)`, width);
  }
}

/**
 * The live-view overlay component (#839). Re-reads the job's ring buffer on
 * every render, so new events appear on the next TUI render cycle without
 * re-creating the component (the deck's 1 s ticker re-renders the TUI tree
 * while the overlay is up).
 *
 * Follows the tail by default; `↑`/`PgUp` scroll up and PAUSE following,
 * `↓`/`PgDn` scroll down, `End` resumes following. `s` opens the steer
 * prompt (the caller re-opens the view after steering); `Esc` closes.
 *
 * Key handling is a direct `matchesKey` dispatch (the same pattern
 * dispatch-deck-nav.ts uses for the global listener). Any key the view does
 * not understand is ignored (typed characters are swallowed by the overlay
 * focus, not forwarded to the editor).
 */
export function createLiveViewComponent(
  key: string,
  header: () => LiveViewHeader | undefined,
  theme: LiveViewTheme,
  done: (result: "close" | "steer") => void,
): Component {
  let offset = 0; // events scrolled back from the tail; 0 = following
  const visible = 24;

  return {
    invalidate(): void {
      /* no cached state */
    },
    render(width: number): string[] {
      const h = header();
      // The header carries the entry label and the last tool name, both of
      // which flow in from untrusted child output — sanitize like any other
      // line, so the overlay header can never desync the renderer either.
      const hline = h
        ? toTerminalLine(
            `${h.label} · ${h.role} · ${formatElapsed(Math.max(0, h.now - h.startedAt))} · ${h.turns} turn${h.turns === 1 ? "" : "s"} · ${h.toolUses} tools · ${h.totalTokens} tokens${h.lastToolName ? ` · last: ${h.lastToolName}` : ""}`,
            width,
          )
        : toTerminalLine(key, width);
      // The overlay's visible window is exactly 24 event rows: header +
      // 24 + hint = 26 rows, NEVER more (pi-tui's overlay compositing is
      // height-sensitive — a taller render ghosts into the chat below).
      const events = getBufferTail(key, visible);
      const lines: string[] = [hline];
      if (events.length === 0) {
        lines.push(theme.muted("no activity yet"));
      } else {
        const start = Math.max(0, events.length - offset - visible);
        for (let i = start; i < events.length; i++) {
          const ev = events[i];
          if (ev) lines.push(renderEvent(ev, theme, width));
        }
      }
      const state =
        offset > 0 ? "paused — ↓/End to follow · s steer · Esc close" : "s steer · Esc close";
      lines.push(theme.muted(state));
      return lines;
    },
    handleInput(data: string): void {
      if (isKeyRelease(data)) return;
      const buf = buffers.get(key);
      const n = buf ? buf.length : 0;
      if (matchesKey(data, "escape")) {
        done("close");
      } else if (matchesKey(data, "s")) {
        done("steer");
      } else if (matchesKey(data, "up") || matchesKey(data, "pageUp")) {
        if (offset === 0 && n === 0) return;
        offset += matchesKey(data, "up") ? 1 : visible;
        offset = Math.min(offset, n);
      } else if (matchesKey(data, "down") || matchesKey(data, "pageDown")) {
        offset = Math.max(0, offset - (matchesKey(data, "down") ? 1 : visible));
      } else if (matchesKey(data, "end")) {
        offset = 0;
      }
    },
  };
}

// =============================================================================
// Overlay open/close (dispatch-deck.ts is the production caller)
// =============================================================================

/**
 * The deck entry the live view is showing (the deck module owns the map;
 * this module only reads through the callback so the two stay decoupled).
 */
export interface LiveViewHost {
  /** The deck entry for the key (structural — the deck module owns the map). */
  getEntry: (key: string) => DeckEntry | undefined;
  buildSteerPrompt: (entry: DeckEntry, now: number) => string;
  steer: (key: string, text: string) => void;
}

/**
 * #839 — open the live-view overlay for a job (the Enter-on-row action).
 * The component is returned DIRECTLY from the factory (never
 * Container-wrapped — #176: keys route to the focused component, a
 * Container swallows them). `s` inside the view opens the existing steer
 * prompt and, after it resolves, the overlay RE-OPENS for the same job so
 * the operator keeps watching; the loop ends on Esc ("close"), on the job
 * settling, or when the deck entry is gone.
 *
 * The buffer's view-open bookkeeping (#916) surrounds the `ctx.ui.custom`
 * call: `markViewOpen` before, `markViewClosed` in a finally — while open,
 * a settling job's `clearEntry` keeps the buffer; on close, an already-
 * settled job's buffer is dropped (no leak).
 */
export async function openLiveView(
  ctx: ExtensionContext,
  key: string,
  host: LiveViewHost,
): Promise<void> {
  markViewOpen(key);
  try {
    for (;;) {
      const result = await ctx.ui.custom<string>(
        (_tui, theme, _kb, done) =>
          createLiveViewComponent(
            key,
            () => {
              const e = host.getEntry(key);
              if (!e) return undefined;
              return {
                label: e.label,
                role: e.state.role,
                startedAt: e.startedAt,
                now: Date.now(),
                turns: e.state.turns,
                toolUses: e.state.toolUses,
                totalTokens: e.state.totalTokens,
                lastToolName: e.state.lastToolName,
              };
            },
            {
              muted: (t) => theme.fg("muted", t),
              error: (t) => theme.fg("error", t),
            } satisfies LiveViewTheme,
            (r) => done(r),
          ),
        { overlay: true },
      );
      if (result !== "steer") break;
      const entry = host.getEntry(key);
      if (!entry) break; // job settled while the overlay was up
      const text = await ctx.ui.editor(
        `Steer ${entry.label}`,
        host.buildSteerPrompt(entry, Date.now()),
      );
      if (text === undefined) break;
      host.steer(key, text);
      // loop → re-open the live view for the same job
    }
  } catch (err) {
    trace(`dispatch-deck-live: live view failed for ${key}: ${(err as Error).message}`);
  } finally {
    markViewClosed(key);
  }
}
