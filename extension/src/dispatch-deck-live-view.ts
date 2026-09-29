/**
 * Live view — the full-screen overlay component host and the open/close
 * loop (#839, #916 SLICE B).
 *
 * Split out from dispatch-deck-live.ts (the per-job ring buffer module)
 * when #916 SLICE A pushed that file past the 500-line cap. The view side
 * owns everything on the render / overlay boundary:
 *
 *   - `createLiveViewComponent` — the FULL-SCREEN agent view (#916 slice B):
 *     a `100%` × `100%` top-left-anchored overlay (the `OverlayOptions` the
 *     pinned pi-tui types accept — `width: "100%"`, `maxHeight: "100%"`,
 *     `anchor: "top-left"`) that renders the job's UNTRUNCATED buffer in
 *     full, wrapped to the render width (the component itself is
 *     dispatch-deck-live-view-component.ts).
 *   - `openLiveView` — the Enter-on-row action (dispatch-deck.ts and
 *     the agent list are the production callers). Surrounds the
 *     `ctx.ui.custom` call with `markViewOpen` / `markViewClosed`
 *     (#916): while open, a settling job's `clearEntry` keeps the buffer;
 *     on close, an already-settled job's buffer is dropped (no leak).
 *
 * The buffer itself (storage, byte bound, settle status, append
 * subscribers, view-open bookkeeping) lives in dispatch-deck-live.ts;
 * this module reads it through the exported seams only.
 *
 * Re-render is event-driven: `onBufferAppend(key, () => tui.requestRender())`
 * re-renders the overlay the moment an event lands (subscribed on open,
 * unsubscribed in the finally), and the deck's 1 s ticker also re-renders
 * the focused component (idempotent — the same buffer, re-read).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import * as agentView from "./dispatch-deck-live-view-component.ts";
import {
  type LiveViewTheme,
  getStatus,
  markViewClosed,
  markViewOpen,
  onBufferAppend,
} from "./dispatch-deck-live.ts";
import type { DeckEntry } from "./dispatch-deck.ts";
import { getNotices, resetNotices } from "./notice-counter.ts";
import { pmActive } from "./pm-active.ts";
import { trace } from "./trace.ts";

export type { LiveViewTheme, ViewHeader, TuiHandle } from "./dispatch-deck-live-view-component.ts";

export const VIEW_FALLBACK_ROWS = agentView.VIEW_FALLBACK_ROWS;
export const VIEW_FOOTER_HINT = agentView.VIEW_FOOTER_HINT;
export {
  createAgentViewComponent,
  getViewScrollState,
  clearViewScroll,
} from "./dispatch-deck-live-view-component.ts";

// The deck's 1 s ticker (dispatch-deck.ts renderNow) re-registers its
// widget and calls requestRender on its 1 s cadence, which re-renders the
// focused component (this overlay) in the same TUI pass — so the overlay
// re-reads the buffer on that cadence WITHOUT owning its own timer, and the
// append subscription (onBufferAppend → tui.requestRender, see
// openLiveView) re-renders the SAME overlay the moment an event lands.
// The two re-render paths are IDEMPOTENT — they re-read the same buffer and
// produce the same lines — so the deck ticker and the append hook can both
// fire for one append without any visible artifact. (Tests drive render()
// and handleInput() directly; a live check covers the cadence on the
// installed Pi, per the issue's AGENTS.md §4 note.)

/**
 * The legacy one-line-per-event overlay component (retained for the
 * pre-#916 test suite's block 3/4 coverage of Esc→close and
 * `s`→steer). New callers use `createAgentViewComponent`.
 */
export function createLiveViewComponent(
  key: string,
  header: () => {
    label: string;
    role: string;
    startedAt: number;
    now: number;
    turns: number;
    toolUses: number;
    totalTokens: number;
    lastToolName?: string;
  },
  theme: LiveViewTheme,
  done: (result: "close" | "steer") => void,
): import("@earendil-works/pi-tui").Component {
  // Delegate to a minimal agent view (the legacy surface is subsumed by
  // the full-screen view; the done results the legacy tests assert —
  // `close` on Esc, `steer` on `s` — are reproduced verbatim).
  return agentView.createAgentViewComponent(
    key,
    () => {
      const h = header();
      if (!h) return undefined as unknown as agentView.ViewHeader;
      return {
        label: h.label,
        role: h.role,
        status: "running",
        startedAt: h.startedAt,
        now: h.now,
        turns: h.turns,
        totalTokens: h.totalTokens,
        pmActive: false,
        notices: 0,
        settled: false,
      };
    },
    theme,
    undefined,
    (r) => done(r === "returnToList" ? "close" : r),
  );
}

// =============================================================================
// Overlay open/close (dispatch-deck.ts and the agent list are the callers)
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
 * #839 — open the full-screen agent view overlay for a job.
 *
 * The component is returned DIRECTLY from the factory (never
 * Container-wrapped — #176: keys route to the focused component, a
 * Container swallows them). The overlay options pin the full-screen
 * shape from the pinned pi-tui types: `width: "100%"` and
 * `maxHeight: "100%"` (both valid `SizeValue` percentage forms) with
 * `anchor: "top-left"` (an `OverlayAnchor` literal).
 *
 * `s` inside the view opens the existing steer prompt and, after it
 * resolves, the overlay RE-OPENS for the same job so the operator keeps
 * watching; the loop ends on Esc ("returnToList"), on the job settling
 * (the view keeps showing the settled content until Esc), or when the
 * deck entry is gone.
 *
 * `opts.onReturnToList` (optional) is invoked on Esc: the agent list
 * passes a callback that re-opens the list, the roster nav passes
 * nothing (Esc just closes).
 *
 * The buffer's view-open bookkeeping (#916) surrounds the `ctx.ui.custom`
 * call: `markViewOpen` before, `markViewClosed` in a finally — while open,
 * a settling job's `clearEntry` keeps the buffer; on close, an already-
 * settled job's buffer is dropped (no leak). The append subscription
 * (event-driven re-render) is unsubscribed in the same finally.
 */
export async function openLiveView(
  ctx: ExtensionContext,
  key: string,
  host: LiveViewHost,
  opts?: { onReturnToList?: () => void },
): Promise<void> {
  markViewOpen(key);
  // Reset the notice counter on open so the badge counts only deliveries
  // while THIS view is open (deliverReport increments; the header reads).
  resetNotices();
  let lastStats = { turns: 0, totalTokens: 0, startedAt: Date.now(), role: "" };
  let tui: TUI | undefined;
  let unsubAppend: (() => void) | undefined;
  try {
    for (;;) {
      const result = await ctx.ui.custom<"close" | "returnToList" | "steer">(
        (tuiHandle, theme, _kb, done) => {
          tui = tuiHandle;
          // Subscribe to appends: re-render the overlay the moment an
          // event lands (unsubscribed in the finally). The deck's 1 s
          // ticker also re-renders the focused component (idempotent).
          unsubAppend = onBufferAppend(key, () => {
            try {
              tuiHandle.requestRender();
            } catch (err) {
              trace(
                `dispatch-deck-live-view: requestRender on append failed: ${(err as Error).message}`,
              );
            }
          });
          return agentView.createAgentViewComponent(
            key,
            () => {
              const e = host.getEntry(key);
              const status = getStatus(key);
              const settled = status !== "running";
              // Header data: the deck entry's RunningState while present,
              // falling back to the last seen values after settle (the
              // entry clears on settle).
              const turns = e?.state.turns ?? lastStats.turns;
              const totalTokens = e?.state.totalTokens ?? lastStats.totalTokens;
              const startedAt = e?.startedAt ?? lastStats.startedAt;
              const role = e?.state.role ?? lastStats.role;
              if (e) {
                lastStats = {
                  turns: e.state.turns,
                  totalTokens: e.state.totalTokens,
                  startedAt: e.startedAt,
                  role: e.state.role,
                };
              }
              return {
                label: e?.label ?? key,
                role,
                status,
                startedAt,
                now: Date.now(),
                turns,
                totalTokens,
                pmActive: pmActive(),
                notices: getNotices(),
                settled,
              };
            },
            {
              muted: (t) => theme.fg("muted", t),
              error: (t) => theme.fg("error", t),
            } satisfies LiveViewTheme,
            tuiHandle,
            (r) => done(r),
          );
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "top-left",
          },
        },
      );
      if (result === "steer") {
        const entry = host.getEntry(key);
        if (!entry) break; // job settled while the overlay was up
        const text = await ctx.ui.editor(
          `Steer ${entry.label}`,
          host.buildSteerPrompt(entry, Date.now()),
        );
        if (text === undefined) break;
        host.steer(key, text);
        // loop → re-open the live view for the same job
        continue;
      }
      // Esc ("returnToList") or "close" — the view is closing.
      if (result === "returnToList") {
        opts?.onReturnToList?.();
      }
      break;
    }
  } catch (err) {
    trace(`dispatch-deck-live: live view failed for ${key}: ${(err as Error).message}`);
  } finally {
    unsubAppend?.();
    markViewClosed(key);
  }
}
