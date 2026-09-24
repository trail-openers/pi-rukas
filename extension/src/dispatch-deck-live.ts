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
 *     Buffers are dropped when the job's deck entry is cleared — no leak
 *     across many dispatches.
 *   - Truncation happens at FEED time: normalised events are stored
 *     already-truncated (assistant text 400, tool args 240, results 200 —
 *     the runs.ts limits). The ring cap (200 events) is the only other
 *     bound.
 *   - `createLiveViewComponent` builds the overlay component (returned
 *     DIRECTLY from the `ctx.ui.custom` factory — never Container-wrapped,
 *     #176). The component re-reads the buffer on every render, so new
 *     events appear on the next render without re-creating the component.
 *
 * Quiet mode (`PI_ENSEMBLE_QUIET_STATUS=1`): `startBuffer` creates no
 * buffer, so a quiet-mode session's rows have no live view at all (the
 * deck itself is hidden too).
 *
 * Out of scope: /runs integration (#836); pause/skip/retry controls;
 * lens-review and adversarial children, which own their deck entries
 * directly and get no buffer (their rows offer steer only).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { DeckEntry } from "./dispatch-deck.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { trace } from "./trace.ts";

// =============================================================================
// Ring buffer
// =============================================================================

/** A normalised (already truncated) unit of a child's recent activity. */
export type LiveEvent =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; name: string; args: string }
  | { kind: "toolResult"; name: string; text: string; isError: boolean };

/** The ring cap — 200 events, oldest evicted. */
export const LIVE_RING_CAP = 200;
/** Assistant text is truncated to this many chars at feed time (PM decision 5). */
export const LIVE_TEXT_MAX = 400;
/** Tool-call argument previews are truncated to this many chars (runs.ts limit). */
export const LIVE_ARGS_MAX = 240;
/** Tool-result previews are truncated to this many chars (runs.ts limit). */
export const LIVE_RESULT_MAX = 200;

/** Truncate with an ellipsis marker, matching runs.ts / progress.ts style. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** One-line, whitespace-normalised preview of a tool call's arguments. */
export function toolCallArgsPreview(args: unknown): string {
  if (args === undefined || args === null) return "";
  const raw = typeof args === "string" ? args : JSON.stringify(args);
  const oneLine = raw.replaceAll(/\s+/g, " ").trim();
  return truncate(oneLine, LIVE_ARGS_MAX);
}

/**
 * The raw-event observer the deck's live view is fed through. Invoked from
 * spawn.ts's line handler for every parsed child event — in practice every
 * assistant `message_end` and every `toolResult` message (everything else is
 * dropped here). Truncation happens HERE, at feed time, so the buffer
 * stores bounded strings only.
 */
export type LiveFeed = (event: PiJsonEvent) => void;

const buffers = new Map<string, LiveEvent[]>();

/**
 * Create (or return) the per-job ring buffer. No-op under quiet mode — a
 * quiet-mode session gets no buffers at all, and the deck entry itself is
 * suppressed there, so the two gates stay in lockstep.
 */
export function startBuffer(key: string): void {
  if (process.env.PI_ENSEMBLE_QUIET_STATUS === "1") return;
  if (!buffers.has(key)) buffers.set(key, []);
}

/** Drop the per-job ring buffer (called when the job's deck entry clears). */
export function dropBuffer(key: string): void {
  buffers.delete(key);
}

/** True when a live-view buffer exists for the key (gate for the row action). */
export function hasBuffer(key: string): boolean {
  return buffers.has(key);
}

/** The buffer contents (a copy — the caller may mutate the array). */
export function getBuffer(key: string): LiveEvent[] {
  return [...(buffers.get(key) ?? [])];
}

/** Buffer count for leak assertions (tests). */
export function bufferCount(): number {
  return buffers.size;
}

/**
 * Feed one parsed child event into the job's ring buffer. Events the
 * overlay cannot show (non-assistant / non-toolResult messages, empty
 * content) are dropped silently. A feed for a key with no buffer (quiet
 * mode, or a lens/adversarial child) is a no-op.
 */
export function feedRawEvent(key: string, event: Parameters<LiveFeed>[0]): void {
  const buf = buffers.get(key);
  if (!buf) return;
  pushEvent(buf, event);
}

/** Push a parsed event onto a ring (module helper, exported for the feed-path test). */
export function pushEvent(buf: LiveEvent[], event: Parameters<LiveFeed>[0]): void {
  if (event.type !== "message" && event.type !== "message_end") return;
  const msg = event.message;
  if (!msg) return;
  if (msg.role === "toolResult") {
    const resultText = (msg.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0)
      .map((b) => b.text as string)
      .join("");
    if (!resultText) return;
    const name = event.toolName;
    appendEvicted(buf, {
      kind: "toolResult",
      name: name ? name : "unknown",
      text: truncate(resultText, LIVE_RESULT_MAX),
      isError: event.isError === true,
    });
    return;
  }
  if (msg.role !== "assistant") return;
  for (const block of msg.content ?? []) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      appendEvicted(buf, { kind: "text", text: truncate(block.text, LIVE_TEXT_MAX) });
    } else if (block.type === "toolCall" && block.name) {
      appendEvicted(buf, {
        kind: "toolCall",
        name: block.name,
        args: toolCallArgsPreview(block.arguments),
      });
    }
  }
}

function appendEvicted(buf: LiveEvent[], ev: LiveEvent): void {
  buf.push(ev);
  while (buf.length > LIVE_RING_CAP) buf.shift();
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

/** Render one buffer event as a single overlay line. */
function renderEvent(ev: LiveEvent, theme: LiveViewTheme): string {
  switch (ev.kind) {
    case "text":
      return ev.text;
    case "toolCall":
      return ev.args ? `→ ${ev.name} ${ev.args}` : `→ ${ev.name}`;
    case "toolResult": {
      const marker = ev.isError ? `✗ ${ev.name} (error)` : `✓ ${ev.name}`;
      return ev.text ? `${ev.isError ? theme.error(marker) : marker} ${ev.text}` : marker;
    }
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

  const fmt = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m${s}s`;
  };

  return {
    invalidate(): void {
      /* no cached state */
    },
    render(width: number): string[] {
      const h = header();
      const hline = h
        ? `${h.label} · ${h.role} · ${fmt(Math.max(0, h.now - h.startedAt))} · ${h.turns} turn${h.turns === 1 ? "" : "s"} · ${h.toolUses} tools · ${h.totalTokens} tokens${h.lastToolName ? ` · last: ${h.lastToolName}` : ""}`
        : key;
      const events = getBuffer(key);
      const lines: string[] = [hline];
      if (events.length === 0) {
        lines.push(theme.muted("no activity yet"));
      } else {
        const start = Math.max(0, events.length - offset - visible);
        for (let i = start; i < events.length; i++) {
          const ev = events[i];
          if (ev) lines.push(renderEvent(ev, theme));
        }
      }
      const state =
        offset > 0 ? "paused — ↓/End to follow · s steer · Esc close" : "s steer · Esc close";
      lines.push(theme.muted(state));
      void width;
      return lines;
    },
    handleInput(data: string): void {
      if (isKeyRelease(data)) return;
      const n = getBuffer(key).length;
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
 */
export async function openLiveView(
  ctx: ExtensionContext,
  key: string,
  host: LiveViewHost,
): Promise<void> {
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
  }
}
