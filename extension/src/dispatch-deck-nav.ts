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
 * Focus gate: `onTerminalInput` listeners run BEFORE pi-tui routes the key
 * to the focused component (TuiBase.handleTerminalInput walks
 * `inputListeners` first), so a listener cannot see who has focus — while
 * the `/model` selector, a `ctx.ui.select/confirm/input` dialog or an
 * overlay has focus, the main editor's text is still empty, which made the
 * roster steal `↓` from those components. The deck therefore injects an
 * `editorFocused()` getter that reports true ONLY when the main editor is
 * the focused component (see dispatch-deck.ts, which duck-types
 * `tui.focusedComponent` + the editor's `focused` flag). The getter is
 * FAIL-CLOSED: an absent or throwing focus signal counts as NOT focused,
 * so the roster never activates when focus cannot be proven. When focus is
 * on some other component, `down` passes through and an in-progress roster
 * mode is exited WITHOUT consuming the key (the key goes on to the
 * focused component).
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
  /**
   * True when the MAIN editor is the focused component, false when some
   * other component (built-in selector, dialog, overlay, ...) has focus or
   * the focus signal is absent/throwing (fail-closed — the roster must
   * not activate when focus cannot be proven to be on the editor). In
   * inactive mode, `down` enters roster mode only when this is `true`;
   * while active, it becomes `false` and roster mode exits WITHOUT
   * consuming the key (the key goes on to the focused component).
   */
  editorFocused: () => boolean;
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
  // Last focus outcome. `false` while roster mode is active triggers the
  // passive exit (any key, un-consumed).
  let lastFocus = true;

  // "Exit roster mode" — the single spelling of that transition, shared by
  // every branch that clears the selection.
  const exit = (): void => {
    active = false;
    selected = undefined;
    onChange();
  };

  // Re-resolve the selection against the current running keys. Returns
  // false when no keys remain (roster mode is exited here). Safe to call
  // with no selection: it keeps the active flag and leaves the handler's
  // next-key logic in charge.
  const reResolve = (): boolean => {
    const keys = get.runningKeys();
    if (keys.length === 0) {
      if (active) exit();
      return false;
    }
    if (!selected) return true;
    const idx = keys.indexOf(selected);
    if (idx !== -1) return true;
    // The selected job settled (its slot is gone from the list). The
    // nearest remaining row is the one that shifted up into its slot —
    // the successor, or the last row if the settled row was the last.
    selected = idx < keys.length - 1 ? keys[idx] : keys[keys.length - 1];
    onChange();
    return true;
  };

  const handler: NavListener = (data) => {
    // Key-release events are ignored entirely (Kitty protocol flag 2).
    if (isKeyRelease(data)) return undefined;

    // Probe focus on every key (cheap flag read; pi-tui toggles the
    // focused component's `focused` flag on every focus change, so there
    // is no state of our own to keep in sync). Focus moving away from
    // the editor while roster mode is active exits roster mode WITHOUT
    // consuming: the key goes on to whatever now has focus.
    lastFocus = get.editorFocused();
    if (active && lastFocus === false) {
      exit();
      return undefined;
    }

    if (active) {
      // --- Roster mode: every key is consumed EXCEPT an unknown key,
      // which exits and is NOT consumed (typing goes to the editor).
      if (matchesKey(data, "escape")) {
        exit();
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        const key = selected;
        exit();
        if (key) onRowConfirm(key);
        return { consume: true };
      }
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        if (!reResolve()) return { consume: true };
        const keys = get.runningKeys();
        const i = selected ? keys.indexOf(selected) : 0;
        const next = keys[Math.min(i + 1, keys.length - 1)];
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
          exit();
        } else {
          selected = keys[i - 1];
          onChange();
        }
        return { consume: true };
      }
      // Any other key: exit roster mode, do NOT consume.
      exit();
      return undefined;
    }

    // --- Inactive: only `down` with an empty editor, the editor focused
    // (fail-closed: an unproven focus must not activate the roster) and a
    // running job.
    const keys = get.runningKeys();
    if (matchesKey(data, "down") && get.editorText() === "" && lastFocus && keys.length > 0) {
      active = true;
      selected = keys[0];
      onChange();
      return { consume: true };
    }
    return undefined;
  };

  return {
    handler,
    isActive: () => active,
    selectedKey: () => (active ? selected : undefined),
  };
}
