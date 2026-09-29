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
import { MAIN_ROW_KEY, STOP_ALL_KEY } from "./agent-list-keys.ts";
import { killJob, killJobs } from "./async-jobs-lifecycle.ts";
import { toTerminalLine } from "./dispatch-deck-line.ts";
import { formatAgentRow } from "./dispatch-deck-rows.ts";
import type { DeckEntry } from "./dispatch-deck.ts";
import { trace } from "./trace.ts";

// #914 — MAIN_ROW_KEY is defined in the leaf agent-list-keys.ts (the
// import cycle is broken by keeping it in the leaf); re-exported from here
// so existing import sites (the smoke tests, dispatch-deck-quiet.ts's
// doc reference) keep their import path.
export { MAIN_ROW_KEY };

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
 * buildAgentListLines), so `selectable` is ALWAYS true for every row the
 * projection produces (main + job rows).
 */
export interface AgentListLine {
  /** MAIN_ROW_KEY for the main row; a job key otherwise. */
  key: string;
  /** The terminal-safe row text. */
  text: string;
  /** True for the `main` row and job rows (every projected row; batch
   *  headers are not in the projection — see above). */
  selectable: boolean;
}

/**
 * Project the agent-list rows: `main` first, then one row per RUNNING job
 * (batch members included, insertion order). Batch headers are NOT in this
 * projection — the composite's batch-headers-only projection (the
 * `lines()` children) renders them, so a batch deck does not double-render
 * its header; the passive mirror (dispatch-deck-composite.ts) adds the
 * header row on top of the same job rows, so the operator sees the header
 * once, up top, exactly as before #914. Every untrusted fragment (label,
 * last tool name + hint) goes through `toTerminalLine` with the caller's
 * width budget.
 */
export function buildAgentListLines(
  entries: readonly DeckEntry[],
  width: number,
  now: number = Date.now(),
): AgentListLine[] {
  const lines: AgentListLine[] = [mainRow(width)];
  // #835 on the live projection: two same-role jobs whose keys share a
  // prefix can render byte-identical rows from spawn until the first
  // updateEntry. Only the rows that WOULD render byte-identical to an
  // already-projected row carry the collision-aware `· key …` fragment
  // (distinctKeyFragments guarantees the fragments are pairwise distinct
  // over the whole set); a unique row stays clean (unconditional appending
  // is visible noise and churns every row on every key churn).
  const fragments = distinctKeyFragments(entries.map((e) => e.key));
  const seen = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as DeckEntry;
    // #914 — the job row carries the full running activity (icon, label,
    // elapsed, last tool + use-count, hint — the formatRow projection)
    // plus the token total (formatAgentRow); the list is the surface that
    // shows the running tool, as the deck row did before #914.
    // Computed once per entry and reused for the collision check and the
    // row projection (the two helpers would otherwise re-project it).
    // The fragment is appended to the raw projection BEFORE the single
    // `toTerminalLine` pass, so the render-width truncation treats row and
    // fragment as one line — the same guarantee the deck row had (the raw
    // row + suffix bounded to one terminal line at the caller's width).
    const plain = formatAgentRow(e, now);
    const frag = fragments[i] ?? "";
    const fragment = e.key.length > 10 ? `key ${frag}` : frag;
    lines.push(
      seen.has(plain) === false && e.key.length <= 10
        ? { key: e.key, text: toTerminalLine(plain, width), selectable: true }
        : { key: e.key, text: toTerminalLine(`${plain} · ${fragment}`, width), selectable: true },
    );
    seen.set(plain, (seen.get(plain) ?? 0) + 1);
  }
  return lines;
}

/**
 * Render one projected row with its list prefix and selected/plain/muted
 * theming — the single definition of the row shape shared by the overlay
 * (createAgentListComponent.render) and the passive-widget mirror
 * (buildCompositeFactory in dispatch-deck-composite.ts). The prefix + row
 * text goes through `toTerminalLine` exactly once, at the caller's width.
 */
export function renderAgentRow(
  row: AgentListLine,
  selected: boolean,
  width: number,
  theme: AgentListTheme,
): string {
  const prefix =
    row.key === MAIN_ROW_KEY ? "◆ " : row.selectable ? (selected ? "> " : "  ") : "   ";
  const line = toTerminalLine(prefix + row.text, width);
  return selected && row.selectable
    ? theme.selected(line)
    : row.selectable
      ? line
      : theme.muted(line);
}

/** The overlay's leading row (Esc-equivalent — closes, never opens). */
export function mainRow(width: number): AgentListLine {
  return {
    key: MAIN_ROW_KEY,
    text: toTerminalLine("main", width),
    selectable: true,
  };
}

/**
 * The `· key …` collision-aware suffix (and the fragment algorithm that
 * supplies it) moved here from dispatch-deck-composite.ts when #914's live
 * projection (buildAgentListLines) took over the guarantee: same-role rows
 * with identical text must stay distinguishable. #835's algorithm, verbatim
 * (previously dead code in the composite, now the LIVE reader).
 */

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

/** The single explicit stop-all scope: job rows = selectable rows minus
 *  the `main` row (the count and the kill action use the SAME filter).
 *  (Replaces the positional `selectableRows().slice(1)` / `length - 1`.)
 */
function jobRowKeys(rows: readonly AgentListLine[]): string[] {
  return rows.filter((r) => r.selectable && r.key !== MAIN_ROW_KEY).map((r) => r.key);
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
  openJob: (key: string) => void | Promise<void>,
  onSettle: () => void,
  theme: () => AgentListTheme,
  done: () => void,
  killJobs: (keys: string[]) => number,
): Component {
  let index = 0;
  let pending: { kind: "kill"; key: string } | { kind: "kill-all" } | undefined;
  let lastRows: AgentListLine[] = [];
  // #914 — onSettle latch: renderable() runs on every render, so without a
  // latch the settled state (rows.length === 1) would re-fire onSettle on
  // every tick. The latch fires it at most once per component, on the
  // first render that sees the settled state (the all-jobs-settled case —
  // the list must close itself once, never re-fire on a later render).
  let settledFired = false;

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
    if (rows.length === 1 && !settledFired) {
      settledFired = true;
      onSettle();
    }
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
        lines.push(renderAgentRow(row, i === index, width, theme()));
      }
      if (pending) {
        const p = pending;
        // The stop-all count and the abort scope are the SAME set: the
        // visible job rows (`main` excluded — it is Esc-equivalent, not a
        // killable agent). Orchestrator / non-deck registry jobs never
        // appear here, so they are never aborted by an in-list stop-all.
        const n = jobRowKeys(lastRows).length;
        const q =
          p.kind === "kill-all"
            ? `Kill ALL ${n} agents? (y/n)`
            : // #914 — do not interpolate the already-truncated `row.text`:
              // build the prompt so the `Kill … (y/n)` framing always fits —
              // re-project the label at the width minus the framing length
              // and apply `toTerminalLine` once to the whole prompt.
              (() => {
                const target = rows.find((r) => r.key === p.key);
                const framing = "Kill  (y/n)";
                const room = Math.max(1, width - framing.length);
                return `Kill ${toTerminalLine(target ? target.text : "?", room)} (y/n)`;
              })();
        lines.push(theme().muted(q));
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
            // #914 — the prompt's count and the abort scope are the SAME
            // set (jobRowKeys); when the registry aborted fewer (jobs that
            // settled after the prompt rendered), record it — the list
            // closes either way.
            const n = jobRowKeys(lastRows);
            const aborted = killJobs(n);
            if (aborted < n.length) {
              trace(
                `agent-list: kill-all aborted ${aborted} of ${n.length} visible jobs (settled in between)`,
              );
            }
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
        // #914 — a last-resort guard: a synchronous throw (or a rejected
        // promise) from the view opener must not escape the TUI input
        // handler.
        try {
          const r = openJob(key);
          if (r instanceof Promise) {
            r.catch((err: unknown) => trace(`agent-list: openJob(${key}) failed: ${String(err)}`));
          }
        } catch (err) {
          trace(`agent-list: openJob(${key}) threw: ${String(err)}`);
        }
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
    openJob: (key: string) => void | Promise<void>;
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
        () => buildAgentListLines(opts.getEntries(), width()),
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
