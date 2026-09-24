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
 * One row of the composite: job key, encoded value, label.
 *
 * TEST-ONLY / deferred pipeline: post-#834 the production per-job rows
 * are built inline in `buildCompositeFactory` straight from `DeckEntry`,
 * so `DeckItem` / `buildDeckItems` / `encodeDeckValue` / `parseDeckValue`
 * have no runtime consumer — they exist for the smoke tests
 * (test-dispatch-deck-interactive.ts, test-dispatch-deck-fragments.ts)
 * and the #835 distinct-fragment behaviour they pin. Retained for the
 * live-view surface (#839 / #836), which will render these values.
 */
export interface DeckItem {
  key: string;
  value: string;
  label: string;
  description?: string;
}

export function encodeDeckValue(key: string): string {
  return `deck::${key}`;
}

export function parseDeckValue(value: string): string | undefined {
  const prefix = "deck::";
  if (!value.startsWith(prefix)) return undefined;
  const key = value.slice(prefix.length);
  return key.length > 0 ? key : undefined;
}

/**
 * Row state for the plain-row rendering (#834).
 * `running` includes batch members (one row per job, #709/#729/#742/#761
 * single-surface invariant); `selected` is the roster-mode `>` target.
 */
export interface DeckRows {
  running: readonly DeckEntry[];
  selectedKey?: string;
  showHint: boolean;
}

/**
 * Build the composite's job rows. One item per RUNNING entry (batch
 * members included), each carrying the job's full `formatRow` line plus
 * a distinct key-fragment description so same-role jobs stay tellable
 * apart (#835). The cancel sentinel is gone with the SelectList (#834) —
 * cancel no longer exists as a deck action.
 */
export function buildDeckItems(
  entries: readonly DeckEntry[],
  now: number = Date.now(),
): DeckItem[] {
  const descriptions = distinctKeyFragments(entries.map((e) => e.key));
  return entries.map((e, i) => ({
    key: e.key,
    value: encodeDeckValue(e.key),
    label: formatRow(e, now),
    description: descriptions[i],
  }));
}

/**
 * Render `key` truncated to a `prefix`-char fragment. ≤10-char keys
 * render verbatim (no marker); longer keys render as "key " + first
 * `prefix` chars (trimEnd) + `…` — unless `prefix` reaches the full key
 * length, in which case the full key renders with no ellipsis.
 */
function keyFragmentAt(key: string, prefix: number): string {
  if (key.length <= 10) return key;
  if (prefix >= key.length) return key;
  return `key ${key.slice(0, prefix).trimEnd()}…`;
}

/**
 * Collision-aware fragments over the whole visible set. Group keys by
 * their current 10-char fragment; for any group with more than one
 * DISTINCT key, increase that group's prefix length by 1 and re-group,
 * repeating until every description is distinct or the prefix reaches
 * the full key length (rendered in full, no ellipsis). Entries whose
 * 10-char fragment is already unique keep the exact current output.
 *
 * Only 2nd+ occurrences in a colliding group lengthen: the first keeps
 * the 10-char form while later ones grow by 1, 2, … — always distinct
 * and all still starting with the 10-char fragment. The loop is
 * bounded: a pass in which no bumpable prefix can change makes further
 * lengthening impossible (duplicates can only persist at this point),
 * so it exits with the fragments as-is — duplicate keys ≤10 chars
 * render verbatim and identical, where the label and value columns
 * still disambiguate.
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
    const rowState = rows();
    const container = new Container();
    const batchLines = lines();
    const visible = batchLines.slice(0, maxRows);
    const overflow = Math.max(0, batchLines.length - maxRows);
    for (const line of visible) container.addChild(new Text(line, 1, 0));
    if (overflow > 0) {
      container.addChild(new Text(theme.fg("muted", `... (${overflow} more)`), 1, 0));
    }
    for (const entry of rowState.running) {
      const label = formatRow(entry, Date.now());
      const isSel = rowState.selectedKey === entry.key;
      const line = isSel ? `> ${label}` : `  ${label}`;
      container.addChild(new Text(line, 1, 0));
    }
    if (rowState.running.length > 0) container.addChild(new Text("", 1, 0));
    if (rowState.showHint) {
      container.addChild(new Text(theme.fg("muted", DECK_HINT_TEXT), 1, 0));
    }
    return container;
  };
}
