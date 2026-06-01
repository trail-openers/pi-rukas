/**
 * Live dispatch deck — footer status entry showing all in-flight subagents.
 *
 * Wired to spawn.ts's onProgress emissions via hooks plumbed through
 * async-jobs.startJob / startBatch and orchestrators that fan out internally
 * (lens-review, adversarial). Renders a multi-line block via
 * ctx.ui.setStatus("ensemble:deck", text); we own the layout, so ordering
 * (insertion-order, stable) and overflow (4 rows + "+N more") are deterministic.
 *
 * Linger: 0s. Rows drop the moment their child finishes. The lifecycle
 * scrollback (#118) is the durable record; PM's reaction text carries any
 * failure context.
 *
 * Opt-out: PI_ENSEMBLE_QUIET_STATUS=1 disables the deck entirely.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type RunningState, emptyRunningState, formatElapsed } from "./progress.ts";
import { trace } from "./trace.ts";

const STATUS_KEY = "ensemble:deck";
const MAX_VISIBLE_ROWS = 4;
const LAST_TEXT_MAX = 60;

export interface DeckEntry {
  /** Stable id; jobId for dispatched specialists, jobId+tag for lens children. */
  key: string;
  /** Label to display (e.g. "developer" or "code-review-specialist[security]"). */
  label: string;
  /** Most recent progress snapshot from the child. */
  state: RunningState;
}

const entries = new Map<string, DeckEntry>();
let activeCtx: ExtensionContext | undefined;
let pendingRender = false;

function isQuiet(): boolean {
  return process.env.PI_ENSEMBLE_QUIET_STATUS === "1";
}

/** Capture the Pi extension context from session_start so we can call setStatus later. */
export function attach(ctx: ExtensionContext): void {
  activeCtx = ctx;
  if (entries.size > 0) scheduleRender();
}

/** Drop the context reference and clear any displayed status. Called on session_shutdown. */
export function detach(): void {
  if (activeCtx) {
    try {
      activeCtx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      /* swallow — session is going away anyway */
    }
  }
  activeCtx = undefined;
  entries.clear();
  pendingRender = false;
}

export interface StartEntryOpts {
  /** Display label, e.g. "developer" or "code-review-specialist[security]". */
  label: string;
  /** Role for the seeded RunningState. */
  role: string;
  /** Optional tag (lens name, batch member index, etc.). */
  tag?: string;
}

export function startEntry(key: string, opts: StartEntryOpts): void {
  if (isQuiet()) return;
  entries.set(key, {
    key,
    label: opts.label,
    state: emptyRunningState(opts.role, opts.tag),
  });
  scheduleRender();
}

export function updateEntry(key: string, state: RunningState): void {
  if (isQuiet()) return;
  const e = entries.get(key);
  if (!e) return;
  e.state = state;
  scheduleRender();
}

export function clearEntry(key: string): void {
  if (entries.delete(key)) scheduleRender();
}

/** Pure snapshot for tests — defensive copy. */
export function snapshot(): DeckEntry[] {
  return [...entries.values()].map((e) => ({
    ...e,
    state: { ...e.state, usage: { ...e.state.usage } },
  }));
}

/** Test-only — purge module state between cases. */
export function reset(): void {
  entries.clear();
  activeCtx = undefined;
  pendingRender = false;
}

function scheduleRender(): void {
  if (pendingRender) return;
  pendingRender = true;
  // Coalesce bursts of updates within one event-loop tick — the child can emit
  // multiple onProgress events in rapid succession (parallel batch starting, a
  // chatty turn, etc.) and we don't need to redraw the footer for each one.
  setImmediate(() => {
    pendingRender = false;
    renderNow();
  });
}

function renderNow(): void {
  if (!activeCtx) return;
  try {
    if (entries.size === 0) {
      activeCtx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    activeCtx.ui.setStatus(STATUS_KEY, formatDeck([...entries.values()]));
  } catch (err) {
    trace(`dispatch-deck: setStatus failed: ${(err as Error).message}`);
  }
}

function truncate(s: string, max: number): string {
  const oneLine = s.replaceAll(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

function formatRow(label: string, state: RunningState, compact: boolean): string {
  const parts: string[] = ["⏳", label, formatElapsed(state.elapsedMs)];
  if (state.lastToolName) {
    parts.push(
      state.toolUses > 1 ? `${state.lastToolName} (#${state.toolUses})` : state.lastToolName,
    );
  }
  let line = parts.join(" · ");
  if (!compact && state.lastText) {
    line += ` — ${truncate(state.lastText, LAST_TEXT_MAX)}`;
  }
  return line;
}

function entryLabel(e: DeckEntry): string {
  return e.label || (e.state.tag ? `${e.state.role}[${e.state.tag}]` : e.state.role);
}

export function formatDeck(list: DeckEntry[]): string {
  if (list.length === 0) return "";
  if (list.length <= MAX_VISIBLE_ROWS) {
    return list.map((e) => formatRow(entryLabel(e), e.state, false)).join("\n");
  }
  // Overflow mode: header + first 4 (insertion order — stable) + "+N more".
  // Picking the most-recently-active would violate stable ordering, so we
  // take the oldest (insertion-order) instead. Detail available via dispatch_status.
  const oldestElapsed = list.reduce((max, e) => Math.max(max, e.state.elapsedMs), 0);
  const header = `⏳ ensemble dispatch · ${list.length} in flight · ${formatElapsed(oldestElapsed)} elapsed`;
  const visible = list.slice(0, MAX_VISIBLE_ROWS);
  const overflow = list.length - MAX_VISIBLE_ROWS;
  const detailLines = visible.map(
    (e) => ` ↳ ${formatRow(entryLabel(e), e.state, true).replace(/^⏳ /, "")}`,
  );
  detailLines.push(` (+${overflow} more — use dispatch_status for full list)`);
  return [header, ...detailLines].join("\n");
}
