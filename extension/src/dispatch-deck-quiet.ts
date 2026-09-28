/**
 * #914 quiet-mode widget suppression for the dispatch deck — moved out of
 * dispatch-deck.ts (whose renderNow carried this block) so that module
 * stays within the 500-line limit; the behaviour is unchanged: quiet
 * mode suppresses ONLY the passive deck widget, so a widget left visible
 * from a pre-quiet render is dropped and nothing is ever set. The roster
 * listener stays quiet-gated in tryAttachNav (dispatch-deck.ts) and the
 * global agent-list shortcut stays live in quiet mode.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

/** #834 — register the roster-mode input listener. Returns true on
 *  success; on failure the deck still renders (only the roster-mode entry
 *  point is unavailable), registration is retried on the next renderNow
 *  (self-heal) and a persistent one surfaces a one-time operator-visible
 *  warning (the trace alone is stderr-only and off unless
 *  PI_ENSEMBLE_DEBUG=1).
 */
export function registerNavListener(
  n: { handler: (data: string) => { consume?: boolean } | undefined },
  ctx: ExtensionContext,
  navUnsub: { current: (() => void) | undefined },
  navWarned: { value: boolean },
): boolean {
  try {
    navUnsub.current = ctx.ui.onTerminalInput(n.handler);
    return true;
  } catch (err) {
    navUnsub.current = undefined;
    console.error(`dispatch-deck: onTerminalInput unavailable: ${(err as Error).message}`);
    if (!navWarned.value) {
      navWarned.value = true;
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
