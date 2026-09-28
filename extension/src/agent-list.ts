/**
 * Agent-list overlay (epic #913 sub-issue 1, issue #914).
 *
 * A global shortcut opens a focused overlay listing `main` plus every
 * RUNNING subagent (label, activity, elapsed, tokens). From the list:
 *
 *   - `Enter` on a job row opens that agent's view (the existing #876
 *     `openLiveView` overlay until #916 lands; #914 calls it verbatim —
 *     the no-buffer steer fallback in `onRowConfirm` stays unchanged, so a
 *     job without a buffer — e.g. a driver child before #838 — opens the
 *     steer prompt); `Enter` on `main` closes the list.
 *   - `x` asks `Kill <label>? (y/n)`; `y` kills exactly that job, `n` (or
 *     anything else) cancels. A job that settles after the confirm is a
 *     no-op in the registry (`killJob` returns false for an unknown id).
 *   - The stop-all chord (`ctrl+x` `ctrl+k` — see agent-list-keys.ts for
 *     the collision evidence) asks `Kill ALL N agents? (y/n)`; `y` calls
 *     `killAllJobs` once and closes the list. `X` is the single-key
 *     fallback (Pi has no multi-key chords in `registerShortcut`, so the
 *     chord is in-list-only).
 *   - `Esc` closes the list back to the main UI.
 *
 * The list is a focused `ctx.ui.custom({ overlay: true })` component. The
 * factory returns the component DIRECTLY — never Container-wrapped (#176:
 * pi-tui routes keys only to the focused component, and a Container has no
 * `handleInput`). While the list is focused, its `handleInput` is the ONLY
 * key sink (pi-tui routes to the focused component first, so the deck's
 * roster listener never sees list keys), and every key the list does not
 * explicitly own is swallowed.
 *
 * Rendering invariant (#927 / PR #928): every row is built with
 * `toTerminalLine(text, width)` — a single terminal row whose visibleWidth
 * is ≤ the render width — and untrusted labels / activity fragments are
 * sanitised at the row boundary, so a hostile label (newline, ANSI, 2000
 * chars, CJK) can never desync pi-tui's line accounting.
 *
 * The module owns BOTH the overlay component (`createAgentListComponent`)
 * and the passive-widget row projection (`buildAgentListLines`) — one
 * definition of the row layout for the two surfaces (the overlay renders
 * the focused list; the deck widget shows a dimmed mirror with the same
 * rows plus the new hint line, so the operator sees the list shape without
 * opening it).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { STOP_ALL_CHORD, STOP_ALL_FALLBACK_KEY } from "./agent-list-keys.ts";
import { killAllJobs, killJob } from "./async-jobs-lifecycle.ts";
import { toTerminalLine } from "./dispatch-deck-line.ts";
import type { BatchDeckEntry, DeckEntry } from "./dispatch-deck.ts";
import { formatElapsed } from "./progress.ts";

/** The leading row's selectable key (Esc-equivalent — closes, never opens). */
export const MAIN_ROW_KEY = "main";

export interface AgentListTheme {
  /** Highlight for the selected row. */
  selected: (t: string) => string;
  /** Muted colour for headers, batch rows and hints. */
  muted: (t: string) => string;
}

/**
 * One projected row of the agent list (shared by the overlay and the
 * passive-widget mirror). Batch headers sit between their members in
 * insertion order (the same shape the deck renders) and are NOT selectable.
 */
export interface AgentListLine {
  /** MAIN_ROW_KEY for the main row; a job key otherwise. */
  key: string;
  /** The terminal-safe row text. */
  text: string;
  /** True for the `main` row and job rows; false for batch headers. */
  selectable: boolean;
  /** True while the underlying job is still running. */
  running: boolean;
}

/**
 * Project the agent-list rows from the deck maps: `main` first, then batch
 * headers / their members / standalone job rows in insertion (seq) order.
 * Batch members sit directly under their header (the header itself is a
 * non-selectable row) — the same shape the deck renders (#834). Every
 * untrusted fragment (label, last tool name + hint) goes through
 * `toTerminalLine` with the caller's width budget.
 */
export function buildAgentListLines(
  entries: readonly DeckEntry[],
  batches: readonly BatchDeckEntry[],
  width: number,
  now: number = Date.now(),
): AgentListLine[] {
  const batchKeys = new Set(batches.map((b) => b.key));
  type Item = { kind: "batch"; b: BatchDeckEntry } | { kind: "job"; e: DeckEntry };
  // Batch members render as their OWN row under the header (the deck's row
  // model, #834/#709 single-surface invariant): the header is a separate
  // non-selectable row, so members are NOT filtered out here.
  const items: Item[] = [
    ...batches.map((b) => ({ kind: "batch" as const, b })),
    ...entries.map((e) => ({ kind: "job" as const, e })),
  ];
  items.sort(
    (a, b) => (a.kind === "batch" ? a.b.seq : a.e.seq) - (b.kind === "batch" ? b.b.seq : b.e.seq),
  );
  const lines: AgentListLine[] = [
    { key: MAIN_ROW_KEY, text: toTerminalLine("main", width), selectable: true, running: true },
  ];
  for (const item of items) {
    if (item.kind === "batch") {
      const running = Math.max(0, item.b.size - item.b.completed);
      lines.push({
        key: item.b.key,
        text: toTerminalLine(
          `batch[${item.b.label}] ${formatElapsed(Math.max(0, now - item.b.startedAt))} · ${item.b.completed}/${item.b.size} done${running > 0 ? ` · ${running} running` : ""}`,
          width,
        ),
        selectable: false,
        running: running > 0,
      });
      continue;
    }
    const e = item.e;
    const tool = e.state.lastToolName
      ? ` · ${e.state.lastToolName}${e.state.toolUses > 1 ? ` (#${e.state.toolUses})` : ""}`
      : "";
    const hint = e.state.lastToolHint ? ` ${e.state.lastToolHint}` : "";
    lines.push({
      key: e.key,
      text: toTerminalLine(
        `${e.label} · ${e.state.role} · ${formatElapsed(Math.max(0, now - e.startedAt))}${tool}${hint} · ${e.state.totalTokens} tok`,
        width,
      ),
      selectable: true,
      running: true,
    });
  }
  return lines;
}

/**
 * Build the agent-list overlay component.
 *
 * `getRows()` projects the current deck maps each render; `openJob(key)`
 * is the Enter-on-job route (the deck module wires it to `onRowConfirm`);
 * `onSettle()` fires when the deck has no running jobs left (only the
 * `main` row remains) and the list must close itself (the main UI is
 * restored — the overlay `done` route); `theme()` supplies the selected /
 * muted styling; `done()` is the overlay's `ctx.ui.custom` done callback.
 *
 * The component swallows every key it owns: arrows, `j`/`k`, `Enter`,
 * `Esc`, `x`, and — while a y/n confirmation is pending — everything
 * except the two answer keys. Kitty key-release events and any other byte
 * (unknown sequences, stray control bytes) are dropped, never forwarded
 * to the editor (the focused component receives them first).
 */
export function createAgentListComponent(
  getRows: () => AgentListLine[],
  width: () => number,
  openJob: (key: string) => void,
  onSettle: () => void,
  theme: () => AgentListTheme,
  done: () => void,
): Component {
  let index = 0;
  let pending: { kind: "kill"; key: string } | { kind: "kill-all" } | undefined;
  let chordArmed = false;
  let lastRows: AgentListLine[] = [];

  const selectableRows = (): AgentListLine[] => lastRows.filter((r) => r.selectable);

  // Re-clamp the selection after rows changed (a job settled). The settled
  // row's neighbour takes its slot; when the selection itself is gone and
  // nothing selectable remains, close the list (the main row is always
  // present, so this is the all-jobs-settled case).
  const reResolve = (): boolean => {
    const rows = selectableRows();
    if (rows.length === 0) return false;
    if (!lastRows[index]?.selectable || lastRows[index]?.key === undefined) {
      index = 0;
      return true;
    }
    const current = lastRows[index]?.key;
    if (rows.some((r) => r.key === current)) return true;
    // The settled row's successor shifts into its slot (or the last row
    // when the settled row was last).
    const idx = lastRows.findIndex((r) => r.key === current);
    const next = rows.findIndex(
      (r) => r.key === (idx < lastRows.length ? lastRows[idx + 1]?.key : undefined),
    );
    index = next === -1 ? rows.length - 1 : next;
    return true;
  };

  // Re-project the rows from the live maps. A batch header is counted as
  // "running" while any of its members run (the deck keeps the batch row
  // in the projection until every member settles), so "the list must
  // close itself" means: nothing but the `main` row remains.
  const renderable = (): AgentListLine[] => {
    const rows = getRows();
    if (rows.length === 1) onSettle();
    return rows;
  };

  return {
    invalidate(): void {
      /* no cached state */
    },
    render(width: number): string[] {
      const rows = renderable();
      lastRows = rows;
      const lines: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const prefix =
          row.key === MAIN_ROW_KEY ? "◆ " : row.selectable ? (i === index ? "> " : "  ") : "   ";
        const line = toTerminalLine(prefix + row.text, width);
        lines.push(
          i === index && row.selectable
            ? theme().selected(line)
            : row.selectable
              ? line
              : theme().muted(line),
        );
      }
      if (pending) {
        const p = pending;
        const n = Math.max(0, selectableRows().length - 1);
        const q =
          p.kind === "kill-all"
            ? `Kill ALL ${n} agents? (y/n)`
            : `Kill ${rows.find((r) => r.key === p.key)?.text ?? "?"} (y/n)`;
        lines.push(toTerminalLine(theme().muted(q), width));
      }
      return lines;
    },
    handleInput(data: string): void {
      // Kitty key-release events (flag-2 forms) and every byte the list
      // does not explicitly own are swallowed: the overlay is focused, so
      // an unhandled key here would otherwise land in the editor.
      if (isKeyRelease(data)) return;
      // A key that breaks the arm of the stop-all chord cancels it
      // (nothing fires; the key is handled below as a fresh press).
      const wasArmed = chordArmed;
      chordArmed = false;

      if (pending) {
        // The y/n confirmation swallows EVERYTHING except the two answer
        // keys (no arrows, no x, no Esc — a miskey during a confirm must
        // not move the selection or close the list).
        if (matchesKey(data, "y")) {
          const p = pending;
          pending = undefined;
          if (p.kind === "kill") {
            killJob(p.key);
          } else {
            killAllJobs();
            done();
            return;
          }
          return;
        }
        if (matchesKey(data, "n") || matchesKey(data, "escape")) {
          pending = undefined;
        }
        return;
      }

      if (matchesKey(data, "escape")) {
        done();
        return;
      }
      if (matchesKey(data, "x")) {
        const row = lastRows[index];
        if (row?.selectable && row.key !== MAIN_ROW_KEY) pending = { kind: "kill", key: row.key };
        return;
      }
      if (wasArmed && matchesKey(data, STOP_ALL_CHORD[1])) {
        pending = { kind: "kill-all" };
        return;
      }
      if (matchesKey(data, STOP_ALL_CHORD[0]) || data === STOP_ALL_FALLBACK_KEY) {
        chordArmed = matchesKey(data, STOP_ALL_CHORD[0]);
        if (data === STOP_ALL_FALLBACK_KEY) pending = { kind: "kill-all" };
        return;
      }
      if (matchesKey(data, "enter")) {
        const row = lastRows[index];
        if (!row?.selectable) return;
        const key = row.key;
        done();
        if (key === MAIN_ROW_KEY) return; // main closes (Esc-equivalent)
        openJob(key);
        return;
      }
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        if (!reResolve()) return;
        const rows = selectableRows();
        const i = rows.findIndex((r) => r.key === lastRows[index]?.key);
        index = Math.min(i < 0 ? 0 : i + 1, rows.length - 1);
        return;
      }
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        if (!reResolve()) return;
        const rows = selectableRows();
        const i = rows.findIndex((r) => r.key === lastRows[index]?.key);
        const target = i <= 0 ? 0 : i - 1;
        index = Math.max(target, 0);
        return;
      }
      // Any other key: swallowed (the overlay owns the input stream).
    },
  };
}

/**
 * The shortcut handler the deck registers with `pi.registerShortcut`:
 * opens the agent-list overlay for `ctx`. The component is returned
 * DIRECTLY from the `ctx.ui.custom` factory (#176 — a Container wrapper
 * would silently drop every key). The width comes from the TUI's terminal
 * (duck-typed, like the deck's focus probe); a missing terminal falls back
 * to 80.
 */
export async function openAgentList(
  ctx: ExtensionContext,
  opts: {
    getEntries: () => readonly DeckEntry[];
    getBatches: () => readonly BatchDeckEntry[];
    openJob: (key: string) => void;
    onSettle: () => void;
  },
): Promise<void> {
  let lastWidth = 80;
  await ctx.ui.custom<unknown>(
    (tui, theme, _kb, done) => {
      const width = () => {
        const cols = (tui as unknown as { terminal?: { columns?: number } })?.terminal?.columns;
        const w = typeof cols === "number" && cols > 0 ? cols : lastWidth;
        lastWidth = w;
        return Math.max(1, w - 2);
      };
      return createAgentListComponent(
        () => buildAgentListLines(opts.getEntries(), opts.getBatches(), width()),
        width,
        opts.openJob,
        opts.onSettle,
        () => ({
          selected: (t) => theme.fg("accent", t),
          muted: (t) => theme.fg("muted", t),
        }),
        () => done(undefined),
      );
    },
    { overlay: true },
  );
}
