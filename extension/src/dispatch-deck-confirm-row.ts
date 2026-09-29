/**
 * The agent-list Enter-on-job confirm route for the dispatch deck (#914)
 * and the deck widget factory (the composite-factory wrapper that captures
 * the TUI instance and builds the agent-list projection). Moved out of
 * dispatch-deck.ts to keep that module within the 500-line limit.
 *
 * Behaviour: `confirmRow` wraps the shared `onRowConfirm` route
 * (buffer → live view, else steer prompt) in a try/catch with a trace —
 * the agent-list overlay calls this fire-and-forget, so a throw here must
 * not become an unhandled rejection. The "no entry" fallthrough (the
 * quiet-mode steer no-op) is traced so an operator can see it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildAgentListLines } from "./agent-list.ts";
import * as deckComposite from "./dispatch-deck-composite.ts";
import { onRowConfirm } from "./dispatch-deck-confirm.ts";
import { buildLinesBatchOnly } from "./dispatch-deck-rows.ts";
import { type BatchDeckEntry, type DeckEntry, rowConfirmHostFor } from "./dispatch-deck.ts";
import { trace } from "./trace.ts";

/** Re-exported so dispatch-deck.ts can reference the factory's return theme type. */
export type { Theme };

/**
 * #914 — route an agent-list Enter on a job row through the deck's
 * unchanged confirm route (buffer → live view, else steer prompt).
 * Wrapped in try/catch with a trace: the agent-list overlay calls this
 * fire-and-forget (item 5), so a throw here must not become an unhandled
 * rejection — the same guarantee onRowConfirm's inner openSteerPrompt
 * already gives for the steer-prompt path. The "no entry" fallthrough
 * (the quiet-mode steer no-op) is traced so an operator can see it.
 */
export async function confirmRow(ctx: ExtensionContext, key: string): Promise<void> {
  try {
    const entry = rowConfirmHostFor(ctx).getEntry(key);
    if (!entry) {
      trace(`dispatch-deck-confirm: confirmRow for unknown key ${key} (quiet-mode steer no-op)`);
      return;
    }
    await onRowConfirm(ctx, key, rowConfirmHostFor(ctx));
  } catch (err) {
    trace(`dispatch-deck-confirm: confirmRow for ${key} failed: ${(err as Error).message}`);
  }
}

/**
 * Build the single composite widget factory (batch rows + per-job plain
 * rows). The Text projection reads `buildLinesBatchOnly` (batch headers
 * only); the per-job rows are one Text row per RUNNING entry (batch
 * members included, #834) with the roster-mode `>` marker and the
 * agent-list hint (buildAgentListHint). renderNow's empty-deck guard
 * tests `entries.size === 0 && batches.size === 0` directly (no
 * projection read) so that a deck with only standalone entries still
 * renders; `buildLines`' output is a strict superset of
 * `buildLinesBatchOnly`'s (both contain batch headers; only `buildLines`
 * adds standalone rows).
 * #914 — the per-job rows ARE the agent-list projection
 * (buildAgentListLines, the shared overlay/widget row layout), and the
 * hint line is the agent-list hint (buildAgentListHint).
 */
export function buildCompositeWidgetFactory(
  getEntries: () => DeckEntry[],
  getBatches: () => BatchDeckEntry[],
  getSelectedKey: () => string | undefined,
  getShowHint: () => boolean,
  maxRows: number,
) {
  return deckComposite.buildCompositeFactory(
    () => buildLinesBatchOnly(new Map(getBatches().map((b) => [b.key, b]))),
    () => ({
      running: getEntries(),
      selectedKey: getSelectedKey(),
      showHint: getShowHint(),
    }),
    () => buildAgentListLines(getEntries(), getBatches(), maxRows),
    maxRows,
  );
}
