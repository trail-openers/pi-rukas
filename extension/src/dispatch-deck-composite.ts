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
import type { SettledEntry } from "./dispatch-deck-settled.ts";
import type { DeckEntry } from "./dispatch-deck.ts";
import { DECK_PROMPT_CANCEL_KEY, formatRow, formatSettledRow } from "./dispatch-deck.ts";
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
  const descriptions = distinctKeyFragments(entries.map((e) => e.key));
  const items: DeckItem[] = entries.map((e, i) => ({
    key: e.key,
    value: encodeDeckValue(e.key),
    label: formatRow(e, now),
    description: descriptions[i],
  }));
  items.push({
    key: DECK_PROMPT_CANCEL_KEY,
    value: encodeDeckValue(DECK_PROMPT_CANCEL_KEY),
    label: "── cancel ──",
  });
  return items;
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
 * batch Text rows and the SelectList cannot split mid-render. `settled`
 * (#837) is the bounded retention list — rendered as a clearly separated
 * trailing section (Text block + SelectList items) above the cancel row.
 */
export function buildCompositeFactory(
  lines: () => string[],
  entries: () => DeckEntry[],
  settled: () => SettledEntry[],
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
    const settledRows = settled();
    const list = buildSelectList(theme, snapshot, settledRows, handlers);
    const container = new Container();
    const batchLines = lines();
    const visible = batchLines.slice(0, maxRows);
    const overflow = Math.max(0, batchLines.length - maxRows);
    for (const line of visible) container.addChild(new Text(line, 1, 0));
    if (overflow > 0) {
      container.addChild(new Text(theme.fg("muted", `... (${overflow} more)`), 1, 0));
    }
    if (settledRows.length > 0) {
      // #837 — the settled section: a clearly separated trailing Text block
      // (these are retention rows, not per-LIVE-job rows — the #742
      // batch-headers-only invariant is preserved) above the SelectList,
      // which carries the selectable settled items.
      container.addChild(new Text(theme.fg("muted", "── settled (recently finished) ──"), 1, 0));
      for (const s of settledRows.slice(0, maxRows)) {
        container.addChild(new Text(formatSettledRow(s), 1, 0));
      }
      const settledOverflow = Math.max(0, settledRows.length - maxRows);
      if (settledOverflow > 0) {
        container.addChild(new Text(theme.fg("muted", `... (${settledOverflow} more)`), 1, 0));
      }
    }
    container.addChild(new Text("", 1, 0));
    container.addChild(list);
    return container;
  };
}

function buildSelectList(
  theme: Theme,
  entries: DeckEntry[],
  settled: SettledEntry[],
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
  // #837 — settled rows join the list as a trailing section (newest first;
  // the caller already ordered them). A separator row makes the boundary
  // visually explicit inside the list; the label carries the full key so
  // settled rows stay distinguishable even when 10-char fragments collide.
  if (settled.length > 0) {
    items.push({ value: "", label: "── settled ──", description: "" });
    for (const s of settled) {
      items.push({
        value: encodeDeckValue(s.key),
        label: formatSettledRow(s),
        description: s.key,
      });
    }
  }
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
  // #837 — the override's intercept path reads the list's items through
  // getSelectedItem(); the stock render path uses the private `items` field
  // directly (same array reference — the override only reads, never
  // reassigns, so no divergence is possible). Expose the public surface
  // here for the test's drive.
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
