/**
 * Row-confirm routing for the dispatch deck (#607 d3 / #839).
 *
 * Enter on a row in roster mode (dispatch-deck.ts `tryAttachNav`) routes
 * through here. The deck shows only RUNNING jobs (entries clear on
 * settle), so a confirmed row is always a running job: with a live-view
 * activity buffer (#839) it opens the live view; without one (lens /
 * adversarial children, which own their entries directly and get no
 * buffer) it opens the steer prompt. Finished runs are out of scope —
 * the operator browses them via /runs.
 */

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as deckComposite from "./dispatch-deck-composite.ts";
import { steerFromDeck } from "./dispatch-deck-interactive.ts";
import { hasBuffer, openLiveView } from "./dispatch-deck-live.ts";
import type { DeckEntry } from "./dispatch-deck.ts";

/** Deck map accessors injected by dispatch-deck.ts (keeps the map private). */
export interface RowConfirmHost {
  getEntry: (key: string) => DeckEntry | undefined;
  /** Deliver a steer to the row's job (`deck-ui` source; shared steer core). */
  steer: (key: string, message: string) => void;
}

/** #607 d3 / #839. Route a confirmed row: buffer → live view, else steer. */
export async function onRowConfirm(
  ctx: ExtensionContext,
  key: string,
  host: RowConfirmHost,
): Promise<void> {
  const entry = host.getEntry(key);
  if (!entry) return;
  if (hasBuffer(key)) {
    await openLiveView(ctx, key, {
      getEntry: (k) => host.getEntry(k),
      buildSteerPrompt: (e, now) => deckComposite.buildSteerPrompt(e, now),
      steer: (k, text) => host.steer(k, text),
    });
    return;
  }
  await openSteerPrompt(ctx, entry, host);
}

/** The pre-filled steer prompt for a row; undefined when the operator cancels. */
async function openSteerPrompt(
  ctx: ExtensionContext,
  entry: DeckEntry,
  host: RowConfirmHost,
): Promise<void> {
  const text = await ctx.ui.editor(
    `Steer ${entry.label}`,
    deckComposite.buildSteerPrompt(entry, Date.now()),
  );
  if (text === undefined) return;
  host.steer(entry.key, text);
}

/** Deliver a steer to a deck row's job (`deck-ui` source; routes through the shared steer core). */
export function steerDeckEntry(ctx: ExtensionUIContext, key: string, message: string): void {
  void steerFromDeck(ctx, key, message);
}
