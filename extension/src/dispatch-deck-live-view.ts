/**
 * Live view — the overlay component and the open/close loop (#839, #916).
 *
 * Split out from dispatch-deck-live.ts (the per-job ring buffer module)
 * when #916 SLICE A pushed that file past the 500-line cap. The view side
 * owns everything on the render / overlay boundary:
 *
 *   - `createLiveViewComponent` — builds the overlay component (returned
 *     DIRECTLY from the `ctx.ui.custom` factory — never Container-wrapped,
 *     #176). The component re-reads the buffer on every render, so new
 *     events appear on the next render without re-creating the component.
 *     Each event renders as ONE line, width-bounded via `toTerminalLine`
 *     (slice B rewrites the view with real wrapping).
 *   - `openLiveView` — the Enter-on-row action (dispatch-deck.ts is the
 *     production caller). Surrounds the `ctx.ui.custom` call with
 *     `markViewOpen` / `markViewClosed` (#916): while open, a settling
 *     job's `clearEntry` keeps the buffer; on close, an already-settled
 *     job's buffer is dropped (no leak).
 *
 * The buffer itself (storage, byte bound, settle status, append
 * subscribers, view-open bookkeeping) lives in dispatch-deck-live.ts;
 * this module reads it through the exported seams only.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { toTerminalLine } from "./dispatch-deck-line.ts";
import { buffers, getBufferTail, markViewClosed, markViewOpen } from "./dispatch-deck-live.ts";
import type { LiveEvent } from "./dispatch-deck-live.ts";
import type { DeckEntry } from "./dispatch-deck.ts";
import { formatElapsed } from "./progress.ts";
import { trace } from "./trace.ts";

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
