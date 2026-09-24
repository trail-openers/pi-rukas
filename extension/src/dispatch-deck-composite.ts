/**
 * The dispatch deck's single composite widget factory (#729, #742, #834).
 *
 * #729 collapsed the deck's two live regions into ONE widget key,
 * "ensemble:deck", so the double-projection is structurally impossible.
 * This module owns the widget's factory: a Container of batch-header Text
 * rows (the deck's batch-headers-only projection) followed by the
 * per-job rows.
 *
 * #834 (epic #833 G1): the non-focusable SelectList that sat in this
 * container is GONE — it never received input (#176: keys route to the
 * focused component, the editor). The per-job surface is now plain Text
 * rows, one per RUNNING job entry (standalone or batch member — batch
 * members are included here because the batch header alone cannot be
 * steered; the header stays as its own Text row for the progress display).
 * While roster mode is active (see dispatch-deck-nav.ts) the selected row
 * carries a `>` marker; when the editor is empty and any job runs, a
 * one-line `↓ select subagents` hint appears below the rows.
 *
 * The composite returns a Container. Pi's setWidget calls
 * `existing.dispose?.()` on the previous component; Container has no
 * dispose, so re-registration is a clean swap.
 *
 * The factory is re-invoked by the deck's 1 s ticker (renderNow re-registers
 * the whole widget), so the rows read a fresh entries snapshot on every
 * render and the nav module's selection state re-resolves naturally.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type TUI, Text } from "@earendil-works/pi-tui";
import { DECK_HINT_TEXT } from "./dispatch-deck-nav.ts";
import { type DeckEntry, formatRow } from "./dispatch-deck.ts";
import { formatElapsed } from "./progress.ts";

/**
 * Row state for the plain-row rendering (#834).
 * `running` includes batch members (one row per job, #709/#729/#742/#761
 * single-surface invariant); `selectedKey` is the roster-mode `>` target.
 */
export interface DeckRows {
  running: readonly DeckEntry[];
  selectedKey?: string;
  showHint: boolean;
}

/**
 * A single per-job row's rendered content, with the collision-aware key
 * fragment (#835) precomputed over the whole visible set. Exported so the
 * distinct-rows behaviour is directly assertable (test-dispatch-deck.ts
 * block 14); the composite is the production caller.
 */
export interface JobRowLine {
  key: string;
  text: string;
}

/**
 * The job rows for the composite: one entry per running entry, in order.
 * `formatRow` alone is not enough — two same-role jobs whose keys share a
 * prefix can render byte-identical rows from spawn until the first
 * `updateEntry` (the #835 class), so every row >10 chars appends a
 * collision-aware `· key …` fragment (≤10-char keys append the key
 * verbatim) that `distinctKeyFragments` guarantees distinct across the set.
 */
export function buildJobRows(running: readonly DeckEntry[], now: number): JobRowLine[] {
  const fragments = distinctKeyFragments(running.map((e) => e.key));
  return running.map((e, i) => ({
    key: e.key,
    text: `${formatRow(e, now)} · ${fragments[i]}`,
  }));
}

/**
 * Render `key` truncated to a `prefix`-char fragment. ≤10-char keys
 * render verbatim (no marker); longer keys render as a 10-char prefix +
 * `…` (the #835 elision shape, trimmed) — unless `prefix` reaches the full
 * key length, in which case the full key renders with no ellipsis.
 */
function keyFragmentAt(key: string, prefix: number): string {
  if (key.length <= 10) return key;
  if (prefix >= key.length) return key;
  return `${key.slice(0, prefix).trimEnd()}…`;
}

/**
 * Collision-aware fragments over the whole visible set (#835's algorithm,
 * ported to the plain-row surface when #834 deleted the SelectList column
 * that was its reader). Group keys by their current fragment; for any group
 * with more than one DISTINCT fragment, increase the 2nd+ occurrence's
 * prefix length by 1 and re-group, repeating until every fragment is
 * distinct or the prefix reaches the full key length (rendered in full,
 * no ellipsis). Entries whose fragment is already unique keep the 10-char
 * form. The loop is bounded: a pass in which no prefix can change makes
 * further lengthening impossible, so it exits as-is — duplicate keys
 * ≤10 chars stay identical, where the row's other content (label, `>`
 * marker, position) still distinguishes them.
 */
function distinctKeyFragments(keys: string[]): string[] {
  const n = keys.length;
  const prefix = keys.map((k) => (k.length > 10 ? 10 : k.length));
  for (;;) {
    const fragments = keys.map((k, i) => keyFragmentAt(k, prefix[i] ?? 10));
    const seen = new Set<string>();
    const bumped = new Set<number>();
    for (let i = 0; i < n; i++) {
      const frag = fragments[i] ?? "";
      if (seen.has(frag)) bumped.add(i);
      seen.add(frag);
    }
    if (bumped.size === 0) return fragments;
    let changed = false;
    for (const i of bumped) {
      const key = keys[i] ?? "";
      const cur = prefix[i] ?? key.length;
      if (cur < key.length) {
        prefix[i] = cur + 1;
        changed = true;
      }
    }
    if (!changed) return fragments;
  }
}

/**
 * The ready-to-send steer prompt for a row.
 * The steer prompt format is load-bearing — downstream steer routing
 * parses this exact shape. Do not change the `[deck-ui steer → …]` prefix
 * or the job-key line without updating the routing.
 */
export function buildSteerPrompt(e: DeckEntry, now: number): string {
  const elapsed = formatElapsed(Math.max(0, now - e.startedAt));
  const tool = e.state.lastToolName ? ` (last tool: ${e.state.lastToolName})` : "";
  return `[deck-ui steer → ${e.label}, job ${e.key}]\nReply with a short status update (≤3 lines), then continue. Running ${elapsed}${tool}.`;
}

/**
 * Build the single composite widget: a Container with the batch-header
 * Text rows (capped at `maxRows` with an overflow indicator when needed),
 * the per-job plain Text rows (one per running entry, `>` on the
 * selected row while roster mode is active), and — when the editor is
 * empty and jobs exist — the one-line `↓ select subagents` hint.
 *
 * The factory returns a Container. Pi's setWidget calls
 * `existing.dispose?.()` on the previous component; Container has no
 * dispose, so re-registration is a clean swap.
 *
 * `lines` is the deck's batch-headers-only projection (batch header rows
 * only) and `rows` is the per-job row state read once per render so the
 * batch Text rows and the job rows cannot split mid-render.
 */
export function buildCompositeFactory(
  lines: () => string[],
  rows: () => DeckRows,
  maxRows: number,
): (tui: TUI, theme: Theme) => Component {
  return (_tui: TUI, theme: Theme) => {
    // Both projections read the deck module's entry/batch maps, which
    // are updated atomically within that module (no concurrent writer),
    // so a mid-render interleaving cannot split the two projections.
    // One clock sample per render: the batch headers and the per-job rows
    // cannot disagree by an elapsed-time tick crossing mid-render.
    const now = Date.now();
    const rowState = rows();
    const container = new Container();
    const batchLines = lines();
    const visible = batchLines.slice(0, maxRows);
    const overflow = Math.max(0, batchLines.length - maxRows);
    for (const line of visible) container.addChild(new Text(line, 1, 0));
    if (overflow > 0) {
      container.addChild(new Text(theme.fg("muted", `... (${overflow} more)`), 1, 0));
    }
    for (const row of buildJobRows(rowState.running, now)) {
      const isSel = rowState.selectedKey === row.key;
      const line = isSel ? `> ${row.text}` : `  ${row.text}`;
      container.addChild(new Text(line, 1, 0));
    }
    if (rowState.running.length > 0) container.addChild(new Text("", 1, 0));
    if (rowState.showHint) {
      container.addChild(new Text(theme.fg("muted", DECK_HINT_TEXT), 1, 0));
    }
    return container;
  };
}
