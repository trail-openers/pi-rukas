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

/** Re-render cadence (ms) — keeps the elapsed timer ticking between assistant
 * turns even when the child emits no events. */
const TICK_INTERVAL_MS = 1000;

const entries = new Map<string, DeckEntry>();
let activeCtx: ExtensionContext | undefined;
let pendingRender = false;
let insertionCounter = 0;
let tickHandle: ReturnType<typeof setInterval> | undefined;

function isQuiet(): boolean {
  return process.env.PI_ENSEMBLE_QUIET_STATUS === "1";
}

function statusKeyFor(entry: DeckEntry): string {
  return `${STATUS_KEY_PREFIX}${entry.seq}-${entry.key}`;
}

function nextSeq(): string {
  return String(insertionCounter++).padStart(6, "0");
}

/** Capture the Pi extension context from session_start so we can call setStatus later. */
export function attach(ctx: ExtensionContext): void {
  activeCtx = ctx;
  if (entries.size > 0) {
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
  if (entries.size === 0) stopTicker();
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
  stopTicker();
  entries.clear();
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
    if (entries.size === 0) return;
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

/**
 * Compact single-line row for one entry — Pi renders these side-by-side,
 * joined by a single space and truncated to terminal width. Keep it short:
 * icon + label + elapsed + tool name (+ use-count if >1). Detailed
 * lastText snippets belong in dispatch_peek, not the deck.
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
  }
  return parts.join(" ");
}
