/**
 * Live view — the full-screen overlay component host and the open/close
 * loop (#839, #916 SLICE B).
 *
 * Split out from dispatch-deck-live.ts (the per-job ring buffer module)
 * when #916 SLICE A pushed that file past the 500-line cap. The view side
 * owns everything on the render / overlay boundary:
 *
 *   - `createAgentViewComponent` — the FULL-SCREEN agent view (#916 slice
 *     B): a `100%` × `100%` top-left-anchored overlay (the `OverlayOptions`
 *     the pinned pi-tui types accept — `width: "100%"`, `maxHeight: "100%"`,
 *     `anchor: "top-left"`) that renders the job's UNTRUNCATED buffer in
 *     full, wrapped to the render width (the component itself is
 *     dispatch-deck-live-view-component.ts). Re-exported from here so
 *     existing import paths keep working.
 *   - `openLiveView` — the Enter-on-row action (dispatch-deck.ts and
 *     the agent list are the production callers). Surrounds the
 *     `ctx.ui.custom` call with `markViewOpen` / `markViewClosed`
 *     (#916): while open, a settling job's `clearEntry` keeps the buffer;
 *     on close, an already-settled job's buffer is dropped (no leak).
 *
 *   #915 — the view now carries an always-focused input line. The steer
 *     re-open loop (`done("steer")` → `ctx.ui.editor`) is RETIRED; sending
 *     is handled INSIDE the component (Enter → the `onSend` callback) and
 *     the overlay stays open. The component's `done` now only returns
 *     `"close"` or `"returnToList"`.
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

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  appendOperatorSteer,
  type LiveViewTheme,
  getStatus,
  hasBuffer,
  markViewClosed,
  markViewOpen,
  onBufferAppend,
} from "./dispatch-deck-live.ts";
import { steerFromDeck } from "./dispatch-deck-interactive.ts";
import type { DeckEntry } from "./dispatch-deck.ts";
import { getNotices, resetNotices } from "./notice-counter.ts";
import { pmActive } from "./pm-active.ts";
import { trace } from "./trace.ts";

// before: `getBuffer` was imported here for the legacy
// createLiveViewComponent shim's empty-buffer check / after: the shim is
// gone (#916 slice B), with it the last import of getBuffer in this file.

// Re-export the view component's public API. These are direct value
// imports (not `agentView.X`) to avoid the circular TDZ error that
// occurs when `agentView` is imported as a namespace from a module that
// imports from this one (dispatch-deck-live.ts re-exports from here).
import {
  clearViewScroll,
  createAgentViewComponent,
  dropOrphanedViewScroll,
  getViewScrollState,
} from "./dispatch-deck-live-view-component.ts";
import type { TuiHandle } from "./dispatch-deck-live-view-component.ts";
export { createAgentViewComponent, getViewScrollState, clearViewScroll, dropOrphanedViewScroll };
export type { LiveViewTheme, TuiHandle };

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
}

/**
 * #915 — the view's send path. `comp` carries the input accessors
 * (`inputValue`/`clearInput`/`setStatus`) the component exposes.
 *
 * The delivery goes through `steerFromDeck` (the same core the PM
 * dispatch_steer tool uses, with the `deck-ui` source tag). Failure shapes:
 *   - delivered → ✓ inline status, input cleared, echo event appended;
 *   - between-rounds (orchestrator) → ⧗ inline status, text KEPT;
 *   - settled / no handle / EPIPE / not delivered → ✗ reason, text KEPT.
 *
 * A throw (e.g. a rejecting `steerFromDeck`) must never escape into the TUI
 * input handler — try/catch plus a trace, the input text left untouched.
 */
/** The input accessors the component exposes (beyond the Component surface). */
interface ViewInputAccessors {
  inputValue: () => string;
  clearInput: () => void;
  setStatus: (s: { text: string; ok: boolean } | undefined) => void;
}

async function handleSend(
  key: string,
  host: LiveViewHost,
  text: string,
  comp: Component & ViewInputAccessors,
): Promise<void> {
  // The label for the echo / status lines: the deck entry's label while
  // running, falling back to the key (a settled job's entry is cleared).
  const entry = host.getEntry(key);
  const label = entry?.label ?? key;
  try {
    const result = await steerFromDeck(
      { notify: (msg: string) => trace(`dispatch-deck-live-view: steer notify: ${msg}`) } as ExtensionUIContext,
      key,
      text,
    );
    if (result.delivered) {
      // ✓ sent — clear the input and append the echo event (the view
      // re-renders via the onBufferAppend subscription).
      comp.clearInput();
      comp.setStatus({ text: "✓ sent", ok: true });
      appendOperatorSteer(key, label, text);
    } else if (result.reason === "between-rounds") {
      // ⧗ between rounds — an orchestrator with no active inner child.
      // The text is KEPT (the operator can retry once a round starts).
      comp.setStatus({ text: "⧗ between rounds — not sent", ok: false });
    } else {
      // ✗ settled / no handle / EPIPE / any other failure — the text is
      // KEPT so the operator can resend once the job is alive again.
      comp.setStatus({ text: `✗ ${result.reason ?? "not delivered"}`, ok: false });
    }
  } catch (err) {
    // A throw must never escape into the TUI input handler — the input text
    // is left untouched and the operator can retry.
    trace(`dispatch-deck-live-view: send failed for ${key}: ${(err as Error).message}`);
    comp.setStatus({ text: `✗ ${(err as Error).message}`, ok: false });
  }
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
 * #915 — the steer re-open loop is retired. The view's input line sends
 * directly (Enter → `onSend`), and the overlay stays open for the whole
 * session; the loop ends on Esc ("returnToList"), on the job settling (the
 * view keeps showing the settled content until Esc), or when the deck
 * entry is gone.
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
    // #915 — the loop is now a single `ctx.ui.custom` call: the input line
    // sends in-place (no re-open), so there is no `continue`. The result is
    // only "close" (the deck nav's cancel) or "returnToList" (Esc / the
    // input's Esc-when-empty).
    const result = await ctx.ui.custom<"close" | "returnToList">(
      (tuiHandle, theme, _kb, done) => {
        tui = tuiHandle;
        // Subscribe to appends: re-render the overlay the moment an
        // event lands (unsubscribed in the finally). The deck's 1 s
        // ticker also re-renders the focused component (idempotent).
        unsubAppend?.();
        unsubAppend = onBufferAppend(key, () => {
          try {
            tuiHandle.requestRender();
          } catch (err) {
            trace(
              `dispatch-deck-live-view: requestRender on append failed: ${(err as Error).message}`,
            );
          }
        });
        const comp = createAgentViewComponent(
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
          (text) => void handleSend(key, host, text, comp),
        );
        return comp;
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
    // Esc ("returnToList") or "close" — the view is closing.
    if (result === "returnToList") {
      // Own try/catch with a distinct trace: a list-reopen failure must
      // not be reported as a live-view failure (the view already closed
      // cleanly). The callback still runs here — AFTER the view closed —
      // so the order with the loop break is unchanged.
      try {
        opts?.onReturnToList?.();
      } catch (err) {
        trace(
          `dispatch-deck-live-view: returnToList callback failed for ${key}: ${(err as Error).message}`,
        );
      }
    }
  } catch (err) {
    trace(`dispatch-deck-live: live view failed for ${key}: ${(err as Error).message}`);
  } finally {
    unsubAppend?.();
    markViewClosed(key);
    // Sweep scroll-state entries left by getViewScrollState's create-on-read
    // path (a view opened for a key, the key dropped, the entry orphaned).
    // The predicate queries the live module's own buffer set — the sweep
    // is called after markViewClosed so the buffer it belongs to may have
    // just been dropped by that call, which is exactly the orphan shape
    // the sweep is for.
    dropOrphanedViewScroll(hasBuffer);
  }
}
