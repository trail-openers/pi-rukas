/**
 * The agent-list shortcut wiring (#916 slice B).
 *
 * One shared closure (`openList`) opens the list overlay and routes
 * Enter-on-job through the deck's confirm route, with the list re-open
 * threaded into the view's Esc route. Lived as an inline closure in
 * index.ts's registerShortcut handler and in a verbatim copy inside
 * smoke-tests/test-agent-list-nav.ts; #916 slice B pulls it out here so
 * both call the same production function instead of two drift-able copies.
 * Sits in its own module so index.ts (production) and the smoke test
 * (test) can both import it without either becoming an import-cycle
 * concern (agent-list.ts and dispatch-deck.ts do not import this file).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openAgentList } from "./agent-list.ts";
import { confirmRow, snapshot } from "./dispatch-deck.ts";

/**
 * #916 SLICE B — the list re-open is one shared closure (`openList`),
 * so EVERY view Esc returns to the list (list → view → Esc → list →
 * view → Esc opens the list 3 times — the second Esc included).
 * `openJob` runs through the REAL deck confirm route; the roster nav
 * path passes nothing, so Esc there just closes, as before.
 */
export function openAgentListWithReturn(ctx: ExtensionContext): Promise<void> {
  const openList = (): Promise<void> =>
    openAgentList(ctx, {
      getEntries: snapshot,
      openJob: (key) =>
        confirmRow(ctx, key, {
          onReturnToList: () => {
            void openList();
          },
        }),
      onSettle: () => {},
    });
  return openList();
}
