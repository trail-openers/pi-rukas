/**
 * Bounded retention of settled deck rows (#837, epic #833 G2).
 *
 * When a deck entry settles it is removed from the live `entries` map —
 * and before #837 the key was only remembered in an unbounded Set
 * (`settledJobs`), so the row vanished from the deck and the settled →
 * transcript-viewer branch in `onRowConfirm` was unreachable dead code
 * (entries.get(key) had just returned undefined).
 *
 * This module keeps a bounded, insertion-ordered list (cap 20, oldest
 * evicted first) of SNAPSHOT copies of settled entries. A snapshot is
 * taken at settle time — never a reference into the live map — because the
 * live entry is gone by the time a settled row is confirmed. The snapshot
 * also carries the child's ACTUAL transcript path (minted inside
 * `spawnSpecialist` as a runId, which can differ from the deck key), so the
 * viewer opens the right file for batch members and `runId/tag`-keyed
 * children whose keys `findTranscriptPath` cannot re-derive.
 *
 * Order stability: each snapshot carries a monotonically increasing
 * `settleSeq`, independent of the deck's resettable insertion counter, so
 * eviction order (oldest first) survives reset() and cap boundaries.
 */

import type { DeckEntry } from "./dispatch-deck.ts";
import type { RunningState } from "./progress.ts";

export const SETTLED_CAP = 20;

/** A snapshot of a deck entry taken at settle time (never a live reference). */
export interface SettledEntry {
  key: string;
  label: string;
  /** Settled successfully (✓) or with a failure (✗). */
  ok: boolean;
  /** Monotonic settle order; eviction is by this, oldest first. */
  settleSeq: number;
  settledAt: number;
  startedAt: number;
  role: string;
  tag?: string;
  /** The child's real transcript file, if the DispatchResult carried one. */
  transcriptPath?: string;
  /** Final RunningState (elapsed, tool count, last text) for the row. */
  state: RunningState;
}

const byKey = new Map<string, SettledEntry>();
// Insertion-ordered key list — eviction walks this from the front.
const order: string[] = [];
let settleCounter = 0;

/**
 * Retain a settled entry (idempotent: re-settling the same key replaces the
 * retained row in place and does not duplicate it or move it in order).
 * Evicts the oldest settled keys until the cap holds.
 */
export function retainSettled(
  entry: DeckEntry,
  opts: { ok: boolean; transcriptPath?: string },
): void {
  const existing = byKey.get(entry.key);
  const snap: SettledEntry = {
    key: entry.key,
    label: entry.label,
    ok: opts.ok,
    settleSeq: existing?.settleSeq ?? ++settleCounter,
    settledAt: Date.now(),
    startedAt: entry.startedAt,
    role: entry.state.role,
    tag: entry.state.tag,
    transcriptPath: opts.transcriptPath,
    // Snapshot — the caller is about to drop the live entry.
    state: { ...entry.state, usage: { ...entry.state.usage } },
  };
  byKey.set(entry.key, snap);
  if (!existing) order.push(entry.key);
  while (order.length > SETTLED_CAP) {
    const oldest = order.shift();
    if (oldest !== undefined) byKey.delete(oldest);
  }
}

/** The retained rows, oldest first (the deck renders them newest first). */
export function settledSnapshot(): SettledEntry[] {
  const out: SettledEntry[] = [];
  for (const k of order) {
    const s = byKey.get(k);
    if (s) out.push(s);
  }
  return out;
}

/** Retained row for a key, or undefined (settled but evicted, or never settled). */
export function getSettled(key: string): SettledEntry | undefined {
  return byKey.get(key);
}

/** True once a key has settled (retained OR already evicted). */
export function isSettled(key: string): boolean {
  return byKey.has(key);
}

/** Drop a settled key without eviction bookkeeping (used by reset/detach). */
export function forgetSettled(key: string): void {
  if (!byKey.delete(key)) return;
  const i = order.indexOf(key);
  if (i >= 0) order.splice(i, 1);
}

/** Clear all retained rows (reset/detach — must not leak across sessions). */
export function clearSettled(): void {
  byKey.clear();
  order.length = 0;
}

/** Reset the monotonic counter (test hygiene only; does NOT clear entries). */
export function resetSettleCounter(): void {
  settleCounter = 0;
}
