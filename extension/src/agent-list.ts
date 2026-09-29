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
 *   - `X` (shift+x, in-list only — see agent-list-keys.ts for the
 *     collision evidence) asks `Kill ALL N agents? (y/n)`; `y` aborts
 *     exactly the N visible job rows (`main` excluded) and closes the
 *     list — the prompt's count and the abort scope are the same set, so
 *     registry jobs the list does not show (batch orchestrators, non-deck
 *     children) are never aborted by an in-list stop-all.
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
import { STOP_ALL_KEY } from "./agent-list-keys.ts";
import { killJob, killJobs } from "./async-jobs-lifecycle.ts";
import { toTerminalLine } from "./dispatch-deck-line.ts";
import { buffers, startBuffer } from "./dispatch-deck-live.ts";
import { suppressWidgetIfQuiet } from "./dispatch-deck-quiet.ts";
import { formatAgentRow } from "./dispatch-deck-rows.ts";
import type { BatchDeckEntry, DeckEntry } from "./dispatch-deck.ts";
import { emptyRunningState } from "./progress.ts";

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
 * passive-widget mirror). Batch headers are NOT in the projection (the
 * deck's batch-headers-only projection renders them — see
 * buildAgentListLines), so `selectable` is true for the `main` and every
 * job row.
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
 * Project the agent-list rows: `main` first, then one row per RUNNING job
 * (batch members included, insertion order). The `batches` parameter is
 * retained for the composite's call signature — batch headers are NOT in
 * this projection (the composite's batch-headers-only projection renders
 * them, so a batch deck does not double-render its header); every
 * untrusted fragment (label, last tool name + hint) goes through
 * `toTerminalLine` with the caller's width budget.
 */
export function buildAgentListLines(
  entries: readonly DeckEntry[],
  _batches: readonly BatchDeckEntry[],
  width: number,
  now: number = Date.now(),
): AgentListLine[] {
  // #914 — batch headers are NOT in the list's own projection: they render
  // via the deck's batch-headers-only projection (the composite's lines()
  // children), so a batch deck does not double-render its header. The
  // overlay shows only the main row + the job rows (batch members included,
  // each with its own row — the #834/#709 single-surface invariant); the
  // passive mirror (dispatch-deck-composite.ts) adds the header row on top
  // of the same job rows, so the operator sees the header once, up top,
  // exactly as before #914.
  const lines: AgentListLine[] = [mainRow(width)];
  for (const e of entries) {
    // #914 — the job row carries the full running activity (icon, label,
    // elapsed, last tool + use-count, hint — the formatRow projection)
    // plus the token total (formatAgentRow); the list is the surface that
    // shows the running tool, as the deck row did before #914.
    lines.push(jobRow(e, width, now));
  }
  return lines;
}

/** The overlay's leading row (Esc-equivalent — closes, never opens). */
export function mainRow(width: number): AgentListLine {
  return {
    key: MAIN_ROW_KEY,
    text: toTerminalLine("main", width),
    selectable: true,
    running: true,
  };
}

/** One job row (the formatAgentRow projection, sanitised at the row boundary). */
export function jobRow(e: DeckEntry, width: number, now: number): AgentListLine {
  return {
    key: e.key,
    text: toTerminalLine(formatAgentRow(e, now), width),
    selectable: true,
    running: true,
  };
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
 * #914 stop-all scope: the `Kill ALL` confirmation reports the number of
 * VISIBLE rows (the job rows above it — the `main` row excluded) and `y`
 * aborts the SAME set — the visible job keys, not the whole registry
 * (`killAllJobs` would abort jobs the list does not show: batch
 * orchestrators, non-deck driver children, jobs absent from the deck
 * maps). `killJobs` is injected so the kill path is unit-testable without
 * the shared registry (the list test drives it with a fake).
 * `killJobs` returns the number of jobs actually aborted — the prompt's
 * count and the action's scope are then proven equal, never assumed.
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
  killJobs: (keys: string[]) => number,
): Component {
  let index = 0;
  let pending: { kind: "kill"; key: string } | { kind: "kill-all" } | undefined;
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

  // Re-project the rows from the live maps. The projection carries the
  // `main` row plus one row per running job, so "the list must close
  // itself" means: nothing but the `main` row remains.
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
        // The stop-all count and the abort scope are the SAME set: the
        // visible job rows (`main` excluded — it is Esc-equivalent, not a
        // killable agent). Orchestrator / non-deck registry jobs never
        // appear here, so they are never aborted by an in-list stop-all.
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
            killJobs(
              selectableRows()
                .slice(1)
                .map((r) => r.key),
            );
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
      if (matchesKey(data, STOP_ALL_KEY)) {
        pending = { kind: "kill-all" };
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
        killJobs,
      );
    },
    { overlay: true },
  );
}

// A minimal fake ctx for the quiet gate test (suppressWidgetIfQuiet calls
// ctx.ui.setWidget when the widget is visible — here it is not, so the
// call is a no-op; the fake needs the shape for the type, not the call).
const fakeCtxWithUi = {
  ui: { setWidget: () => {}, notify: () => {} },
  hasUI: true,
} as unknown as ExtensionContext;

// ---------------------------------------------------------------------------
// 8. Quiet-mode gate relocation (issue #914 / the adversarial round).
//    The `PI_ENSEMBLE_QUIET_STATUS` early return that lived in
//    dispatch-deck-live.ts `startBuffer` is REMOVED — buffers are ALWAYS
//    created, because quiet mode now only suppresses the PASSIVE deck
//    widget (dispatch-deck.ts `renderNow`); the agent list / roster still
//    open the live view for a quiet session's rows. This block is the
//    guard against regressing the relocation: it pins the two gates in
//    opposite directions and proves the quiet gate CHANGED (buffers
//    created) while the one that KEPT (the widget) is still suppressed.
// ---------------------------------------------------------------------------
{
  const NOW = 2_000_000;
  const entries: DeckEntry[] = [
    {
      key: "job-q",
      label: "Q",
      state: emptyRunningState("developer"),
      seq: 0,
      startedAt: NOW - 60_000,
    },
  ];
  const quietSaved = process.env.PI_ENSEMBLE_QUIET_STATUS;
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  try {
    // The quiet gate that CHANGED: startBuffer no longer early-returns.
    // The buffer is created and the live view is available for a quiet
    // session's rows (the list opens it via onRowConfirm, which reads the
    // buffer — a quiet session with no buffer would fall through to the
    // steer prompt, which is itself quiet-gated in dispatch-deck-interactive.
    // The buffer existing is the load-bearing fact: it is the data the
    // live view renders, and its absence was the old quiet gate's effect.
    startBuffer("job-q");
    const buf = buffers.get("job-q");
    if (!buf || buf.length !== 0) {
      console.error(
        "✗ 8a: quiet mode still suppresses startBuffer (the gate was moved) — buffer absent",
      );
      process.exit(1);
    }
    console.log("✓ 8a: startBuffer creates a buffer in quiet mode (the gate moved)");

    // The quiet gate that KEPT: renderNow still suppresses the widget.
    // `suppressWidgetIfQuiet` returns true while quiet, so renderNow
    // returns early and the deck widget is never set.
    const quietSuppressed = suppressWidgetIfQuiet(
      fakeCtxWithUi,
      "ensemble:deck",
      () => false,
      () => {},
    );
    if (!quietSuppressed) {
      console.error(
        "✗ 8b: suppressWidgetIfQuiet returned false in quiet mode (the kept gate is gone)",
      );
      process.exit(1);
    }
    console.log(
      "✓ 8b: suppressWidgetIfQuiet still suppresses the widget in quiet mode (the kept gate)",
    );

    // The agent list is reachable in quiet mode (the global shortcut is
    // registered regardless — index.ts); the list's own rows project
    // normally. This is the load-bearing fact for a quiet session: the
    // operator can open the list and the live view without the widget.
    const lines = buildAgentListLines(entries, [], 80, NOW);
    if (lines.length !== 2 || lines[0]?.key !== MAIN_ROW_KEY || lines[1]?.key !== "job-q") {
      console.error("✗ 8c: agent list does not project rows in quiet mode");
      process.exit(1);
    }
    console.log("✓ 8c: the agent list projects its rows in quiet mode (the list is live)");

    // The live view opens for a quiet session's row: the buffer exists
    // (proven above) and the live-view component reads it on every
    // render (dispatch-deck-live.ts) — the openLiveView route in
    // onRowConfirm does not gate on quiet mode. This is the behavioural
    // consequence of the gate relocation.
    const liveViewAvailable = buf !== undefined;
    if (!liveViewAvailable) {
      console.error("✗ 8d: the live view is unavailable for a quiet session's row");
      process.exit(1);
    }
    console.log("✓ 8d: the live view is available for a quiet session's row (the gate moved)");
  } finally {
    if (quietSaved === undefined) process.env.PI_ENSEMBLE_QUIET_STATUS = undefined;
    else process.env.PI_ENSEMBLE_QUIET_STATUS = quietSaved;
    buffers.delete("job-q");
  }
}
