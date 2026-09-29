/**
 * #914 quiet-mode widget suppression and nav listener registration —
 * moved out of dispatch-deck.ts (renderNow / tryAttachNav) to keep that
 * module within the 500-line limit. Behaviour unchanged: quiet mode
 * suppresses ONLY the passive deck widget (a pre-quiet widget is dropped,
 * nothing is ever set; the roster listener stays quiet-gated and the
 * global agent-list shortcut stays live in quiet mode), and the nav
 * listener registration self-heals (retry on next renderNow; a persistent
 * failure surfaces a one-time operator-visible warning — the trace alone
 * is stderr-only and off unless PI_ENSEMBLE_DEBUG=1).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

// Module-level state owned by this module (dispatch-deck.ts no longer
// holds navUnsub / navWarned / widgetVisible — the state moved here with
// its single writer (setDeckWidget in dispatch-deck.ts's renderNow path
// via setWidgetVisible) and reader (suppressWidgetIfQuiet / getNavUnsub),
// so the flag and the setWidget call stay in lockstep in one module).
let navUnsub: (() => void) | undefined;
let navWarned = false;
let widgetVisible = false;

export function getWidgetVisible(): boolean {
  return widgetVisible;
}

export function setWidgetVisible(v: boolean): void {
  widgetVisible = v;
}

export function getNavUnsub(): (() => void) | undefined {
  return navUnsub;
}
export function clearNavUnsub(): void {
  navUnsub = undefined;
}

/**
 * Drop a still-visible deck widget when quiet mode is active; returns true
 * while quiet (the caller must skip rendering), false otherwise. Reads and
 * writes this module's own `widgetVisible` flag (no injected callbacks —
 * the flag lives where it is read, so the two cannot drift).
 */
export function suppressWidgetIfQuiet(ctx: ExtensionContext, key: string): boolean {
  if (process.env.PI_ENSEMBLE_QUIET_STATUS !== "1") return false;
  if (widgetVisible) {
    try {
      ctx.ui.setWidget(key, undefined);
    } catch {}
    widgetVisible = false;
  }
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
export function registerNavListener(
  n: { handler: (data: string) => { consume?: boolean } | undefined },
  ctx: ExtensionContext,
): boolean {
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
