/**
 * The dispatch deck's single composite widget factory (#729, #742).
 *
 * #729 collapsed the deck's two live regions (belowEditor detail deck +
 * aboveEditor SelectList) into ONE widget key, "ensemble:deck", so the
 * double-projection is structurally impossible. This module owns the
 * widget's factory: a Container of batch-header Text rows (the deck's
 * batch-headers-only projection) followed by the
 * keyboard-selectable SelectList. #742 removed the per-job Text rows —
 * the `buildLines` output used to re-render every job as a plain Text
 * child above the list whose labels were byte-identical `formatRow` lines,
 * so each job rendered twice. The SelectList is now the sole per-job
 * surface (one item per job, key disambiguation in the description
 * column); batch headers have no list counterpart of their own, so they
 * keep their Text projection.
 *
 * The composite returns a Container. pi-tui's focus model routes keys to
 * `tui.getFocusedComponent()`, which is the editor unless the composite
 * explicitly focuses the SelectList (see `buildCompositeFactory`). The
 * #176 Container-doesn't-forward-input caveat does NOT apply here because
 * Pi's interactive mode only calls `focusedComponent.handleInput`; the
 * editor owns focus until the user tabs into the list.
 *
 * Placement: belowEditor — the deck's long-standing home. The aboveEditor
 * slot is deliberately left free; a widget there would sit between the
 * status line and the editor, which is real estate the operator types in.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  SelectList,
  type TUI,
  Text,
  getKeybindings,
} from "@earendil-works/pi-tui";
import type { DeckEntry } from "./dispatch-deck.ts";
import { DECK_PROMPT_CANCEL_KEY, formatRow } from "./dispatch-deck.ts";
import { formatElapsed } from "./progress.ts";

/** One row of the composite's SelectList: job key, encoded value, label. */
export interface DeckItem {
  key: string;
  value: string;
  label: string;
  description?: string;
}

const COMPOSITE_MAX_VISIBLE = 12;

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
 * Build the composite's SelectList rows. One item per job entry, plus the
 * cancel sentinel. The label is the job's full `formatRow` line; the
 * description carries the key fragment so same-role jobs stay
 * distinguishable when the list is long. The SelectList is the sole
 * per-job surface (#742).
 */
export function buildDeckItems(
  entries: readonly DeckEntry[],
  now: number = Date.now(),
): DeckItem[] {
  const items: DeckItem[] = entries.map((e) => ({
    key: e.key,
    value: encodeDeckValue(e.key),
    label: formatRow(e, now),
    description: keyFragment(e.key),
  }));
  items.push({
    key: DECK_PROMPT_CANCEL_KEY,
    value: encodeDeckValue(DECK_PROMPT_CANCEL_KEY),
    label: "── cancel ──",
  });
  return items;
}

/**
 * The SelectList's description column: a key fragment that keeps
 * same-role jobs distinguishable. Keys ≤10 chars render verbatim (no
 * marker); longer keys elide to a 10-char prefix + `…`. The prefix is
 * sufficient for the common case (job keys embed a unique run-id in the
 * first 10 chars, e.g. `df8a-7r`).
 */
function keyFragment(key: string): string {
  const frag = key.length <= 10 ? key : `${key.slice(0, 10).trimEnd()}…`;
  return `${key.length > 10 ? "key " : ""}${frag}`;
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
 * a blank separator, and the keyboard-selectable SelectList — the sole
 * per-job surface (#742). The SelectList is the focus target inside the
 * container; Pi's `focusedComponent.handleInput` routes keys to it only
 * when the user tabs in, so the composite never steals editor input by
 * default.
 *
 * The factory returns a Container. Pi's setWidget calls
 * `existing.dispose?.()` on the previous component; Container has no
 * dispose, so re-registration is a clean swap.
 *
 * `lines` is the deck's batch-headers-only projection (batch header rows
 * only; the per-job rows are the SelectList's, one row each — #742) and
 * `entries` is the job snapshot; both are read once per render so the
 * batch Text rows and the SelectList cannot split mid-render.
 */
export function buildCompositeFactory(
  lines: () => string[],
  entries: () => DeckEntry[],
  maxRows: number,
  handlers: {
    onRowConfirm: (key: string) => void;
    onSelectionChange: () => void;
  },
): (tui: TUI, theme: Theme) => Component {
  return (tui: TUI, theme: Theme) => {
    // One snapshot per render: the batch rows and the list read the same
    // entries so a mid-render update cannot split the two projections.
    const snapshot = entries();
    const list = buildSelectList(theme, snapshot, handlers);
    const container = new Container();
    const batchLines = lines();
    const visible = batchLines.slice(0, maxRows);
    const overflow = Math.max(0, batchLines.length - maxRows);
    for (const line of visible) container.addChild(new Text(line, 1, 0));
    if (overflow > 0) {
      container.addChild(new Text(theme.fg("muted", `... (${overflow} more)`), 1, 0));
    }
    container.addChild(new Text("", 1, 0));
    container.addChild(list);
    return container;
  };
}

function buildSelectList(
  theme: Theme,
  entries: DeckEntry[],
  handlers: {
    onRowConfirm: (key: string) => void;
    onSelectionChange: () => void;
  },
) {
  const items = buildDeckItems(entries).map((it) => ({
    value: it.value,
    label: it.label,
    description: it.description,
  }));
  const tl = {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.bg("selectedBg", t),
    description: (t: string) => theme.fg("dim", t),
    scrollInfo: (t: string) => theme.fg("muted", t),
    noMatch: (t: string) => theme.fg("muted", t),
  };
  const list = new SelectList(items, COMPOSITE_MAX_VISIBLE, tl, {
    minPrimaryColumnWidth: 24,
    maxPrimaryColumnWidth: 60,
  });
  list.onSelectionChange = () => handlers.onSelectionChange();
  const kb = getKeybindings();
  const orig = list.handleInput.bind(list);
  list.handleInput = (data: string): void => {
    if (kb.matches(data, "tui.select.confirm")) {
      const cur = list.getSelectedItem();
      if (cur) {
        const key = parseDeckValue(cur.value);
        if (key && key !== DECK_PROMPT_CANCEL_KEY) handlers.onRowConfirm(key);
        return;
      }
    }
    orig(data);
  };
  return list;
}
