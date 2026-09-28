/**
 * Agent-list key choices and the passive-widget hint (issue #914).
 *
 * The key choices live here (not in agent-list.ts) so the collision test
 * can import them alongside `buildAgentListHint` without pulling the
 * component's module graph into a test that only checks the key table.
 *
 * Chosen keys and the collision evidence (issue #914 acceptance criterion
 * "the chord-collision test proves the shortcut and stop-all chords are
 * unbound in Pi's built-in table"):
 *
 *   - list opening: `ctrl+l` (LIST_SHORTCUT). Pi's built-in table has no
 *     `ctrl+l` binding — `ctrl+l` is not among the 33 bound keys in the
 *     installed pi-tui keybinding table (verified at test time via
 *     `getKeybindings().getResolvedBindings()`), so the editor is
 *     unaffected.
 *   - stop-all: `ctrl+x ctrl+k` (STOP_ALL_CHORD, a two-press chord owned
 *     by the list's input state machine — `ctrl+x` arms the chord,
 *     `ctrl+k` within it fires the confirmation prompt, any other key
 *     cancels it). Pi does NOT support multi-key chords via
 *     `registerShortcut` (one KeyId per shortcut —
 *     `registerShortcut(shortcut: KeyId, …)`), so the chord is
 *     in-list-only, and `X` inside the list is the single-key fallback
 *     (STOP_ALL_FALLBACK_KEY). Neither form is a global binding:
 *     standalone `ctrl+k` is bound (`tui.editor.deleteToLineEnd`),
 *     standalone `ctrl+x` is bound (`app.message.copy`), but the CHORD is
 *     a sequence Pi's single-key matcher cannot see.
 *
 * The collision test (smoke-tests/test-dispatch-deck-list.ts) asserts at
 * test time against the installed `getKeybindings()` table.
 */

import { MAIN_ROW_KEY, buildAgentListLines } from "./agent-list.ts";
import type { BatchDeckEntry, DeckEntry } from "./dispatch-deck.ts";

/** The global shortcut that opens the agent-list overlay. */
export const LIST_SHORTCUT = "ctrl+l";

/** The stop-all chord (in-list): `ctrl+x` arms it, `ctrl+k` fires it. */
export const STOP_ALL_CHORD: ["ctrl+x", "ctrl+k"] = ["ctrl+x", "ctrl+k"];

/** The single-key stop-all fallback inside the list (mirrors `x`→kill). */
export const STOP_ALL_FALLBACK_KEY = "X";

/**
 * The passive-widget hint line. The row projection above it is exactly the
 * agent-list projection (buildAgentListLines in agent-list.ts: `main` +
 * batch headers / job rows, #914), so the footer always shows the list's
 * shape — including the leading `main` row the ↓ roster treats as
 * Esc-equivalent.
 */
export function buildAgentListHint(width: number): string {
  return `↓ agents · Enter view · x stop · ${STOP_ALL_CHORD[0]} ${STOP_ALL_CHORD[1]} stop all · Esc close`;
}
