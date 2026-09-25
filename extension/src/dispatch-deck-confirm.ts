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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as deckComposite from "./dispatch-deck-composite.ts";
import { hasBuffer, openLiveView } from "./dispatch-deck-live.ts";
import type { DeckEntry } from "./dispatch-deck.ts";
import { trace } from "./trace.ts";

/** Deck map accessors injected by dispatch-deck.ts (keeps the map private). */
export interface RowConfirmHost {
  getEntry: (key: string) => DeckEntry | undefined;
  /**
   * Deliver a steer to the row's job. The host is built per-attach from the
   * confirming ctx (dispatch-deck.ts `rowConfirmHostFor`) so the steer goes
   * through the shared steer core with a UI that can notify on failure —
   * never silently dropped.
   */
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

/**
 * The pre-filled steer prompt for a row; undefined when the operator cancels.
 * A rejecting editor (e.g. an unsupported surface) is caught and traced,
 * mirroring `openLiveView`'s catch — an editor throw must not escape into
 * the roster input handler.
 */
async function openSteerPrompt(
  ctx: ExtensionContext,
  entry: DeckEntry,
  host: RowConfirmHost,
): Promise<void> {
  try {
    const text = await ctx.ui.editor(
      `Steer ${entry.label}`,
      deckComposite.buildSteerPrompt(entry, Date.now()),
    );
    if (text === undefined) return;
    host.steer(entry.key, text);
  } catch (err) {
    trace(`dispatch-deck-confirm: steer prompt failed for ${entry.key}: ${(err as Error).message}`);
  }
}
