/**
 * The agent-list Enter-on-job confirm route for the dispatch deck (#914)
 * and the deck widget factory (the composite-factory wrapper that captures
 * the TUI instance and builds the agent-list projection). The second
 * responsibility is the passive below-editor widget factory
 * `buildCompositeWidgetFactory`; moved out of dispatch-deck.ts to keep
 * that module within the 500-line limit.
 *
 * Behaviour: `confirmRow` wraps the shared `onRowConfirm` route
 * (buffer → live view, else steer prompt) in a try/catch with a trace —
 * the agent-list overlay calls this fire-and-forget, so a throw here must
 * not become an unhandled rejection.
 *
 * The route takes the `RowConfirmHost` as a parameter (dispatch-deck.ts
 * supplies `rowConfirmHostFor(ctx)` in its thin `confirmRow` wrapper) so
 * this module never imports a VALUE from dispatch-deck.ts — type-only
 * imports stay — which breaks the dispatch-deck.ts ↔ this module import
 * cycle.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildAgentListLines } from "./agent-list.ts";
import * as deckComposite from "./dispatch-deck-composite.ts";
import { type RowConfirmHost, onRowConfirm } from "./dispatch-deck-confirm.ts";
import { buildLinesBatchOnly } from "./dispatch-deck-rows.ts";
import type { BatchDeckEntry, DeckEntry } from "./dispatch-deck.ts";
import { trace } from "./trace.ts";

/**
 * #914 — route an agent-list Enter on a job row through the deck's
 * unchanged confirm route (buffer → live view, else steer prompt).
 * Wrapped in try/catch with a trace: the agent-list overlay calls this
 * fire-and-forget (item 5), so a throw here must not become an unhandled
 * rejection — the same guarantee onRowConfirm's inner openSteerPrompt
 * already gives for the steer-prompt path.
 *
 * The route is NOT skipped for unknown keys: in quiet mode buffers exist
 * without deck entries (startEntry is quiet-gated), and the FIRST branch of
 * onRowConfirm opens the live view whenever a BUFFER exists, before it ever
 * reads the entry. An early return here was a regression — Enter no longer
 * opened the live view for quiet sessions.
 */
export async function confirmRow(
  ctx: ExtensionContext,
  key: string,
  host: RowConfirmHost,
  opts?: { onReturnToList?: () => void },
): Promise<void> {
  try {
    await onRowConfirm(ctx, key, host, opts);
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
    (width) => buildAgentListLines(getEntries(), width),
    maxRows,
  );
}
