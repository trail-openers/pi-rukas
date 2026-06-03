/**
 * Live dispatch deck — a multi-line widget showing all in-flight subagents.
 *
 * Rendering uses `ctx.ui.setWidget("ensemble:deck", lines, { placement:
 * "belowEditor" })`. The widget accepts `string[]` (one element per visible
 * line) so we control vertical layout explicitly — unlike `setStatus`, which
 * Pi joins onto a single footer line with a space separator (see #141).
 *
 * Hierarchy:
 *   ⏳ batch[developer×3] 1m04s · 1/3 done · 2 running
 *    ↳ developer[task-A] 1m04s bash yarn test
 *    ↳ developer[task-B] 1m04s read src/auth.ts
 *   ⏳ explore 0m23s grep "lifecycle hook patterns"
 *
 * - Top-level rows use the `⏳` icon — batch summaries OR standalone subagents.
 * - Member rows are indented with ` ↳ ` (no icon) — they belong to the batch
 *   directly above them.
 * - Ordering: top-level items in global insertion order; members within their
 *   batch in member insertion order.
 *
 * Wired to spawn.ts's onProgress emissions via hooks plumbed through
 * async-jobs.startJob / startBatch and orchestrators that fan out internally
 * (lens-review, adversarial).
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

const WIDGET_KEY = "ensemble:deck";
const HINT_MAX = 50;

export interface DeckEntry {
  /** Stable id; jobId for dispatched specialists, jobId+tag for lens children. */
  key: string;
  /** Label to display (e.g. "developer" or "code-review-specialist[security]"). */
  label: string;
  /** Most recent progress snapshot from the child. */
  state: RunningState;
  /**
   * Internal monotonic insertion sequence — used to order top-level items and
   * members consistently. Not encoded into any user-visible identifier;
   * the widget's `string[]` ordering is what Pi sees.
   */
  seq: number;
  /** When this entry was registered. Used at render time to compute fresh
   *  elapsed regardless of when the child last emitted an event (#131). */
  startedAt: number;
  /**
   * When this entry belongs to a parallel/lens batch, the batch's key.
   * Render groups members under their batch row with indentation (#141).
   */
  batchKey?: string;
}

/**
 * Persistent batch-summary row (#139). One per dispatch_parallel batch and
 * one per dispatch_lens_review invocation; survives individual member
 * completions so the user retains the "I dispatched N" context after fast
 * members have already dropped from the deck at 0s linger.
 */
export interface BatchDeckEntry {
  key: string;
  /** Human-friendly batch label, e.g. "explore×3", "code-review-specialist×6". */
  label: string;
  /** Total member count (immutable for the batch's lifetime). */
  size: number;
  /** Members that have settled (success or failure). Mutable. */
  completed: number;
  seq: number;
  startedAt: number;
}

/** Re-render cadence (ms) — keeps the elapsed timer ticking between assistant
 * turns even when the child emits no events. */
const TICK_INTERVAL_MS = 1000;

const entries = new Map<string, DeckEntry>();
const batches = new Map<string, BatchDeckEntry>();
let activeCtx: ExtensionContext | undefined;
let pendingRender = false;
let insertionCounter = 0;
let tickHandle: ReturnType<typeof setInterval> | undefined;
let widgetVisible = false;

function isQuiet(): boolean {
  return process.env.PI_ENSEMBLE_QUIET_STATUS === "1";
}

function nextSeq(): number {
  return insertionCounter++;
}

/** Capture the Pi extension context from session_start so we can call setWidget later. */
export function attach(ctx: ExtensionContext): void {
  activeCtx = ctx;
  if (entries.size > 0 || batches.size > 0) {
    startTickerIfNeeded();
    scheduleRender();
  }
}

/** Drop the context reference and clear the widget. Called on session_shutdown. */
export function detach(): void {
  stopTicker();
  if (activeCtx && widgetVisible) {
    try {
      activeCtx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* session is going away anyway */
    }
  }
  activeCtx = undefined;
  entries.clear();
  batches.clear();
  pendingRender = false;
  widgetVisible = false;
}

export interface StartEntryOpts {
  /** Display label, e.g. "developer" or "code-review-specialist[security]". */
  label: string;
  /** Role for the seeded RunningState. */
  role: string;
  /** Optional tag (lens name, batch member index, etc.). */
  tag?: string;
  /**
   * When this entry is a member of a parallel/lens batch, the parent batch's
   * key. Render groups members under their batch row with indentation.
   */
  batchKey?: string;
}

export function startEntry(key: string, opts: StartEntryOpts): void {
  if (isQuiet()) return;
  entries.set(key, {
    key,
    label: opts.label,
    state: emptyRunningState(opts.role, opts.tag),
    seq: nextSeq(),
    startedAt: Date.now(),
    batchKey: opts.batchKey,
  });
  startTickerIfNeeded();
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
  if (!entries.delete(key)) return;
  scheduleRender();
  if (entries.size === 0 && batches.size === 0) stopTicker();
}

export interface StartBatchEntryOpts {
  /**
   * Display label rendered inside `batch[...]`. Caller is responsible for
   * choosing meaningful text — e.g. "explore×3" for a uniform-role batch,
   * "code-review-specialist×6" for lens review, or "mixed×3" when the
   * member roles differ.
   */
  label: string;
  /** Number of children in the batch (immutable). */
  size: number;
}

/**
 * Register a persistent batch-summary row. Lives until clearBatchEntry is
 * called — survives individual member completions. Register BEFORE the
 * member entries so its `seq` is lower; render places batch rows before
 * their members in the widget content array.
 */
export function startBatchEntry(key: string, opts: StartBatchEntryOpts): void {
  if (isQuiet()) return;
  batches.set(key, {
    key,
    label: opts.label,
    size: opts.size,
    completed: 0,
    seq: nextSeq(),
    startedAt: Date.now(),
  });
  startTickerIfNeeded();
  scheduleRender();
}

/** Bump the `completed` counter shown in the batch row. Called from each
 * member's settle path so the user sees "1/3 done · 2 running" advance. */
export function updateBatchProgress(key: string, completed: number): void {
  if (isQuiet()) return;
  const b = batches.get(key);
  if (!b) return;
  b.completed = Math.max(b.completed, completed);
  scheduleRender();
}

export function clearBatchEntry(key: string): void {
  if (!batches.delete(key)) return;
  scheduleRender();
  if (entries.size === 0 && batches.size === 0) stopTicker();
}

/** Pure snapshot of single entries — used by dispatch_peek. Batches are
 * UI sugar and not subagents, so peek skips them by design. */
export function snapshot(): DeckEntry[] {
  return [...entries.values()].map((e) => ({
    ...e,
    state: { ...e.state, usage: { ...e.state.usage } },
  }));
}

/** Pure snapshot of batch rows — test-only. */
export function batchSnapshot(): BatchDeckEntry[] {
  return [...batches.values()].map((b) => ({ ...b }));
}

/** Test-only — purge module state between cases. */
export function reset(): void {
  stopTicker();
  entries.clear();
  batches.clear();
  activeCtx = undefined;
  pendingRender = false;
  insertionCounter = 0;
  widgetVisible = false;
}

/** Test-only — is the self-tick interval armed? */
export function isTicking(): boolean {
  return tickHandle !== undefined;
}

function startTickerIfNeeded(): void {
  if (tickHandle !== undefined || isQuiet()) return;
  tickHandle = setInterval(() => {
    if (entries.size === 0 && batches.size === 0) return;
    scheduleRender();
  }, TICK_INTERVAL_MS);
  // Don't keep the Node process alive on this timer — it's purely UI.
  tickHandle.unref?.();
}

function stopTicker(): void {
  if (tickHandle === undefined) return;
  clearInterval(tickHandle);
  tickHandle = undefined;
}

function scheduleRender(): void {
  if (pendingRender) return;
  pendingRender = true;
  // Coalesce bursts of updates within one event-loop tick — the child can emit
  // multiple onProgress events in rapid succession (parallel batch starting, a
  // chatty turn, etc.) and we don't need to repaint the widget for each one.
  setImmediate(() => {
    pendingRender = false;
    renderNow();
  });
}

function renderNow(): void {
  if (!activeCtx) return;
  const lines = buildLines();
  try {
    if (lines.length === 0) {
      if (widgetVisible) {
        activeCtx.ui.setWidget(WIDGET_KEY, undefined);
        widgetVisible = false;
      }
      return;
    }
    activeCtx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
    widgetVisible = true;
  } catch (err) {
    trace(`dispatch-deck: setWidget failed: ${(err as Error).message}`);
  }
}

/**
 * Assemble the multi-line content for the widget.
 * Order: top-level items (batches + standalone singles) interleaved by global
 * insertion seq; members nested under their parent batch in member seq order.
 *
 * Exposed for tests — production callers use renderNow().
 */
export function buildLines(now: number = Date.now()): string[] {
  // Group entries by batchKey: each batch's members + the standalone (non-batched) ones.
  const byBatch = new Map<string, DeckEntry[]>();
  const standalone: DeckEntry[] = [];
  for (const e of entries.values()) {
    if (e.batchKey && batches.has(e.batchKey)) {
      const arr = byBatch.get(e.batchKey) ?? [];
      arr.push(e);
      byBatch.set(e.batchKey, arr);
    } else {
      standalone.push(e);
    }
  }

  // Unified top-level traversal: batches + standalone singles, sorted by seq
  // so the user sees them in dispatch order.
  type TopLevel = { kind: "batch"; b: BatchDeckEntry } | { kind: "single"; e: DeckEntry };
  const topLevel: TopLevel[] = [
    ...[...batches.values()].map((b) => ({ kind: "batch" as const, b })),
    ...standalone.map((e) => ({ kind: "single" as const, e })),
  ];
  topLevel.sort((a, b) => {
    const sa = a.kind === "batch" ? a.b.seq : a.e.seq;
    const sb = b.kind === "batch" ? b.b.seq : b.e.seq;
    return sa - sb;
  });

  const lines: string[] = [];
  for (const item of topLevel) {
    if (item.kind === "batch") {
      lines.push(formatBatchRow(item.b, now));
      const members = (byBatch.get(item.b.key) ?? []).slice().sort((a, b) => a.seq - b.seq);
      for (const m of members) {
        lines.push(formatMemberRow(m, now));
      }
    } else {
      lines.push(formatRow(item.e, now));
    }
  }
  return lines;
}

function entryLabel(e: DeckEntry): string {
  return e.label || (e.state.tag ? `${e.state.role}[${e.state.tag}]` : e.state.role);
}

function truncateHint(s: string): string {
  const oneLine = s.replaceAll(/\s+/g, " ").trim();
  if (oneLine.length <= HINT_MAX) return oneLine;
  return `${oneLine.slice(0, HINT_MAX - 1).trimEnd()}…`;
}

/**
 * The bits after the row's leading icon: `<label> <elapsed> [<tool>(#N) <hint>]`.
 * Shared between top-level rendering (formatRow) and indented member
 * rendering (formatMemberRow).
 */
function formatRowCore(entry: DeckEntry, now: number): string {
  const elapsedMs = Math.max(0, now - entry.startedAt);
  const parts: string[] = [entryLabel(entry), formatElapsed(elapsedMs)];
  if (entry.state.lastToolName) {
    parts.push(
      entry.state.toolUses > 1
        ? `${entry.state.lastToolName} (#${entry.state.toolUses})`
        : entry.state.lastToolName,
    );
    if (entry.state.lastToolHint) {
      parts.push(truncateHint(entry.state.lastToolHint));
    }
  }
  return parts.join(" ");
}

/**
 * Top-level row: `⏳ <label> <elapsed> <tool>(#N) <hint>`. Used for batch
 * summaries (via formatBatchRow) and standalone (non-batched) singles.
 */
export function formatRow(entry: DeckEntry, now: number = Date.now()): string {
  return `⏳ ${formatRowCore(entry, now)}`;
}

/**
 * Indented member row: ` ↳ <label> <elapsed> <tool>(#N) <hint>`. No icon —
 * the `↳` is the visual indicator that this row belongs to the batch
 * directly above it.
 */
export function formatMemberRow(entry: DeckEntry, now: number = Date.now()): string {
  return ` ↳ ${formatRowCore(entry, now)}`;
}

/**
 * `⏳ batch[<label>] <elapsed> · <done>/<size> done` — persistent summary
 * row for a parallel/lens batch. Survives individual member completions so
 * the user retains the "I dispatched N" context after fast members have
 * dropped at 0s linger (#139).
 */
export function formatBatchRow(batch: BatchDeckEntry, now: number = Date.now()): string {
  const elapsedMs = Math.max(0, now - batch.startedAt);
  const running = Math.max(0, batch.size - batch.completed);
  const tail = running > 0 ? ` · ${running} running` : "";
  return `⏳ batch[${batch.label}] ${formatElapsed(elapsedMs)} · ${batch.completed}/${batch.size} done${tail}`;
}
