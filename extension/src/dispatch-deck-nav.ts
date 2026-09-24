/**
 * Roster-mode nav state machine for the dispatch deck (#834, epic #833 G1).
 *
 * The deck is a passive belowEditor widget — pi-tui routes keys to the
 * focused component (the editor), so the deck itself never sees them. This
 * module owns the small global `ctx.ui.onTerminalInput` listener that lets
 * the operator walk the RUNNING subagents from an empty editor, mirroring
 * nicobailon/pi-subagents' fleet status:
 *
 *  - Inactive: `down` is consumed ONLY when the editor text is empty AND at
 *    least one running entry (standalone or batch member) exists. Every
 *    other key passes through untouched — the editor behaves exactly as
 *    today.
 *  - Active ("roster mode"): down/up (and j/k) move the selection, clamped;
 *    up at the first row or Esc exits; Enter confirms the selected row via
 *    the existing `onRowConfirm` route (steer prompt for a running job);
 *    ANY other key exits roster mode and is NOT consumed, so typing goes
 *    straight to the editor.
 *
 * Selection is by job key and is re-resolved against the current deck
 * contents on every key press and every render (the deck re-registers its
 * widget wholesale on its 1 s ticker — see dispatch-deck.ts renderNow — so
 * the row component is rebuilt and reads fresh state each time). If the
 * selected job settles, the selection moves to the nearest remaining row,
 * or roster mode exits when none remain.
 *
 * Key-release events (Kitty protocol) are ignored — an unhandled release
 * lets pi-tui route it on, which the TUI filters for non-release-hungry
 * focused components.
 *
 * Known behaviour change (documented in docs/configuration.md): from an
 * EMPTY editor, `down` no longer walks prompt history while subagents are
 * running.
 *
 * The module is a stateful helper object factory: dispatch-deck.ts owns
 * the deck entries and the onRowConfirm wiring; the handler only talks to
 * the deck through the injected getters/setters, so the state machine is
 * unit-testable with a fake `ctx.ui` and no Pi process.
 */

import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

export const DECK_HINT_TEXT = "↓ select subagents";

/** Minimal shape of the deck the nav handler needs. */
export interface DeckNavGetters {
  /** One key per RUNNING job — batch members included, insertion order. */
  runningKeys: () => string[];
  /** The editor's current text ("" when empty). */
  editorText: () => string;
  /** True while at least one running job exists (hint visibility). */
  hasRunning: () => boolean;
}

/** The listener handler returned to `ctx.ui.onTerminalInput`. */
export type NavListener = (data: string) => { consume?: boolean } | undefined;

export interface DeckNav {
  /** The global input listener. Consume semantics per the module header. */
  handler: NavListener;
  /** True while roster mode is active (the `>` marker renders). */
  isActive: () => boolean;
  /** The selected job key, if roster mode is active and the key still runs. */
  selectedKey: () => string | undefined;
}

/**
 * Build the roster-mode state machine.
 *
 * `onRowConfirm(key)` is invoked for an Enter press — after roster mode
 * exits — so the steer prompt (or whatever confirms the row) can take
 * focus. `onChange()` fires after every state transition that alters the
 * selection or active flag, so the deck can re-render the `>` marker.
 */
export function createDeckNav(
  get: DeckNavGetters,
  onRowConfirm: (key: string) => void,
  onChange: () => void,
): DeckNav {
  let active = false;
  let selected: string | undefined;

  // Re-resolve the selection against the current running keys. Returns
  // false when no keys remain (roster mode is exited here).
  const reResolve = (): boolean => {
    const keys = get.runningKeys();
    if (keys.length === 0) {
      if (active) {
        active = false;
        selected = undefined;
        onChange();
      }
      return false;
    }
    if (!selected) return true;
    const idx = keys.indexOf(selected);
    if (idx !== -1) return true;
    // The selected job settled (its slot is gone from the list). The
    // nearest remaining row is the one that shifted up into its slot —
    // the successor, or the last row if the settled row was the last.
    const fallback = idx < keys.length - 1 ? keys[idx] : keys[keys.length - 1];
    selected = fallback ?? keys[0];
    onChange();
    return true;
  };

  const handler: NavListener = (data) => {
    // Key-release events are ignored entirely (Kitty protocol flag 2).
    if (isKeyRelease(data)) return undefined;

    if (active) {
      // --- Roster mode: every key is consumed EXCEPT an unknown key,
      // which exits and is NOT consumed (typing goes to the editor).
      if (matchesKey(data, "escape")) {
        active = false;
        selected = undefined;
        onChange();
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        const key = selected;
        active = false;
        selected = undefined;
        onChange();
        if (key) onRowConfirm(key);
        return { consume: true };
      }
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        if (!reResolve()) return { consume: true };
        const keys = get.runningKeys();
        const i = selected ? keys.indexOf(selected) : 0;
        const next = keys[Math.min(i + 1, keys.length - 1)] ?? keys[0];
        if (next !== selected) {
          selected = next;
          onChange();
        }
        return { consume: true };
      }
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        if (!reResolve()) return { consume: true };
        const keys = get.runningKeys();
        const i = selected ? keys.indexOf(selected) : 0;
        if (i <= 0) {
          active = false;
          selected = undefined;
          onChange();
        } else {
          selected = keys[i - 1];
          onChange();
        }
        return { consume: true };
      }
      // Any other key: exit roster mode, do NOT consume.
      active = false;
      selected = undefined;
      onChange();
      return undefined;
    }

    // --- Inactive: only `down` with an empty editor and a running job.
    if (matchesKey(data, "down") && get.editorText() === "" && get.hasRunning()) {
      const keys = get.runningKeys();
      if (keys.length > 0) {
        active = true;
        selected = keys[0];
        onChange();
        return { consume: true };
      }
    }
    return undefined;
  };

  return {
    handler,
    isActive: () => active,
    selectedKey: () => (active ? selected : undefined),
  };
}
