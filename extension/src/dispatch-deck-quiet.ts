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
// holds navUnsub / navWarned — they move here with the helper).
let _navUnsub: (() => void) | undefined;
let _navWarned = false;

export function _getNavUnsub(): (() => void) | undefined {
  return _navUnsub;
}
export function _clearNavUnsub(): void {
  _navUnsub = undefined;
}

/**
 * Drop a still-visible deck widget when quiet mode is active; returns true
 * while quiet (the caller must skip rendering), false otherwise.
 */
export function suppressWidgetIfQuiet(
  ctx: ExtensionContext,
  key: string,
  isVisible: () => boolean,
  setVisible: (v: boolean) => void,
): boolean {
  if (process.env.PI_ENSEMBLE_QUIET_STATUS !== "1") return false;
  if (isVisible()) {
    try {
      ctx.ui.setWidget(key, undefined);
    } catch {}
    setVisible(false);
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
    _navUnsub = ctx.ui.onTerminalInput(n.handler);
    return true;
  } catch (err) {
    _navUnsub = undefined;
    trace(`dispatch-deck: onTerminalInput unavailable: ${(err as Error).message}`);
    if (!_navWarned) {
      _navWarned = true;
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
