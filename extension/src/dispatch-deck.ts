/**
 * Live dispatch deck — one footer status entry per in-flight subagent.
 *
 * Why one-key-per-child (not one combined entry with multi-line text): Pi's
 * footer sanitizes \n/\t/\r to spaces and joins all extension statuses with
 * a single space (see footer-data-provider + interactive/components/footer.js
 * sanitizeStatusText). Multi-line text gets collapsed onto one line and reads
 * badly. With one key per child Pi renders them side-by-side as designed,
 * and truncates at terminal width when there are too many.
 *
 * Wired to spawn.ts's onProgress emissions via hooks plumbed through
 * async-jobs.startJob / startBatch and orchestrators that fan out internally
 * (lens-review, adversarial).
 *
 * Linger: 0s. Rows drop the moment their child finishes. The lifecycle
 * scrollback (#118) is the durable record; PM's reaction text carries any
 * failure context.
 *
 * Ordering: Pi sorts setStatus entries alphabetically by key. We prefix the
 * key with a zero-padded insertion-sequence number so visual order matches
 * insertion order (the jobId alone would tie-break random within a single ms
 * for parallel/lens-review fan-outs).
 *
 * Opt-out: PI_ENSEMBLE_QUIET_STATUS=1 disables the deck entirely.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type RunningState, emptyRunningState, formatElapsed } from "./progress.ts";
import { trace } from "./trace.ts";

const STATUS_KEY_PREFIX = "ensemble:deck:";
const HINT_MAX = 50;

export interface DeckEntry {
  /** Stable id; jobId for dispatched specialists, jobId+tag for lens children. */
  key: string;
  /** Label to display (e.g. "developer" or "code-review-specialist[security]"). */
  label: string;
  /** Most recent progress snapshot from the child. */
  state: RunningState;
  /** Zero-padded insertion sequence. Encoded into the setStatus key so Pi's
   *  alphabetical sort matches dispatch order. */
  seq: string;
  /** When this entry was registered. Used at render time to compute fresh
   *  elapsed regardless of when the child last emitted an event (#131). */
  startedAt: number;
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
  seq: string;
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

function isQuiet(): boolean {
  return process.env.PI_ENSEMBLE_QUIET_STATUS === "1";
}

function statusKeyFor(entry: DeckEntry | BatchDeckEntry): string {
  return `${STATUS_KEY_PREFIX}${entry.seq}-${entry.key}`;
}

function nextSeq(): string {
  return String(insertionCounter++).padStart(6, "0");
}

/** Capture the Pi extension context from session_start so we can call setStatus later. */
export function attach(ctx: ExtensionContext): void {
  activeCtx = ctx;
  if (entries.size > 0 || batches.size > 0) {
    startTickerIfNeeded();
    scheduleRender();
  }
}

/** Drop the context reference and clear any displayed statuses. Called on session_shutdown. */
export function detach(): void {
  stopTicker();
  if (activeCtx) {
    for (const entry of entries.values()) {
      try {
        activeCtx.ui.setStatus(statusKeyFor(entry), undefined);
      } catch {
        /* session is going away anyway */
      }
    }
    for (const batch of batches.values()) {
      try {
        activeCtx.ui.setStatus(statusKeyFor(batch), undefined);
      } catch {
        /* session is going away anyway */
      }
    }
  }
  activeCtx = undefined;
  entries.clear();
  batches.clear();
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
    seq: nextSeq(),
    startedAt: Date.now(),
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
  const e = entries.get(key);
  if (!e) return;
  entries.delete(key);
  if (activeCtx) {
    try {
      activeCtx.ui.setStatus(statusKeyFor(e), undefined);
    } catch (err) {
      trace(`dispatch-deck: clear setStatus failed: ${(err as Error).message}`);
    }
  }
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
 * member entries so its seq is lowest and Pi's alphabetical sort places it
 * first on the footer line.
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
  const b = batches.get(key);
  if (!b) return;
  batches.delete(key);
  if (activeCtx) {
    try {
      activeCtx.ui.setStatus(statusKeyFor(b), undefined);
    } catch (err) {
      trace(`dispatch-deck: clear setStatus failed: ${(err as Error).message}`);
    }
  }
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
  // chatty turn, etc.) and we don't need to repaint the footer for each one.
  setImmediate(() => {
    pendingRender = false;
    renderNow();
  });
}

function renderNow(): void {
  if (!activeCtx) return;
  try {
    for (const batch of batches.values()) {
      activeCtx.ui.setStatus(statusKeyFor(batch), formatBatchRow(batch));
    }
    for (const entry of entries.values()) {
      activeCtx.ui.setStatus(statusKeyFor(entry), formatRow(entry));
    }
  } catch (err) {
    trace(`dispatch-deck: setStatus failed: ${(err as Error).message}`);
  }
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
 * Compact single-line row for one entry — Pi renders these side-by-side,
 * joined by a single space and truncated to terminal width. Keep it short:
 * icon + label + elapsed + tool name (+ use-count if >1) + truncated hint
 * extracted from the tool's primary arg (e.g. the bash command, file path,
 * grep pattern). The hint makes "bash (#14)" actually informative — see
 * #139 / progress.ts:extractToolHint.
 *
 * Elapsed is computed fresh from entry.startedAt at render time (#131) — NOT
 * from state.elapsedMs, which is only updated on assistant-turn boundaries.
 * The self-tick interval keeps re-rendering at ~1Hz so the timer stays live
 * between turns.
 */
export function formatRow(entry: DeckEntry, now: number = Date.now()): string {
  const elapsedMs = Math.max(0, now - entry.startedAt);
  const parts: string[] = ["⏳", entryLabel(entry), formatElapsed(elapsedMs)];
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
