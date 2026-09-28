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
 *   - list opening: `alt+a` (LIST_SHORTCUT). `alt+a` is unbound in BOTH
 *     tables Pi resolves — the installed pi-tui table
 *     (`getKeybindings().getResolvedBindings()`) and the pi-coding-agent
 *     `KEYBINDINGS` (`app.*` ids) — verified at test time against both,
 *     with a control assertion that `ctrl+l` IS detected as bound in the
 *     app table (where `app.model.select` owns it) so the test cannot
 *     pass vacuously. (The first pass of this issue chose `ctrl+l` after
 *     reading only the pi-tui table — that is the collision that led to
 *     this re-choice. #914 — the list shortcut was changed from `ctrl+l`
 *     to `alt+a` for exactly this reason.)
 *   - stop-all: `X` (STOP_ALL_KEY, a single key — shift+x) inside the
 *     list overlay ONLY, with the y/n confirm. The `ctrl+x ctrl+k` global
 *     chord that the first pass registered is REMOVED: `ctrl+x` is bound
 *     globally (`app.message.copy`) and the two-press in-list chord added
 *     a second global registration without adding capability the single
 *     in-list key does not already provide. `X` matches pi-tui's
 *     case-sensitive KeyId (`matchesKey("X", "X")` is true, `matchesKey
 *     ("x", "X")` is false), so a plain `x` (kill-one) never fires it,
 *     and `ctrl+x` (0x18) matches neither.
 *
 * The collision test (smoke-tests/test-dispatch-deck-list.ts) asserts at
 * test time against the installed `getKeybindings()` table.
 */

import { MAIN_ROW_KEY, buildAgentListLines } from "./agent-list.ts";
import type { BatchDeckEntry, DeckEntry } from "./dispatch-deck.ts";

/** The global shortcut that opens the agent-list overlay. */
export const LIST_SHORTCUT = "alt+a";

/** The in-list stop-all key (a single key — shift+x, `Shift+X` on the keyboard). */
export const STOP_ALL_KEY = "shift+x";

/**
 * The passive-widget hint line. The row projection above it is exactly the
 * agent-list projection (buildAgentListLines in agent-list.ts: `main` +
 * batch headers / job rows, #914), so the footer always shows the list's
 * shape — including the leading `main` row the ↓ roster treats as
 * Esc-equivalent.
 */
export function buildAgentListHint(width: number): string {
  return `↓ agents · Enter view · x stop · ${STOP_ALL_KEY} stop all · Esc close`;
}
