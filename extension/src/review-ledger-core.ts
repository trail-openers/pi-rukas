/**
 * review-ledger-core — the dedupe invariant, split from review-ledger.ts
 * so the #1069 race-fallback helper (review-ledger-merge.ts) can import it
 * without an import cycle (merge is imported BY review-ledger.ts).
 *
 * `dedupeLatest` is the ONE function that keeps at most one row per
 * (branch, kind): the guard (latestEntry) reads only the latest, so older
 * rows are dead weight. Both the happy path (review-ledger.ts) and the
 * race-fallback merge (review-ledger-merge.ts) apply it.
 */

import type { LedgerEntry } from "./review-ledger.ts";

/**
 * Keep only the latest entry per (branch, kind) — the guard reads only
 * the latest, so older rows are never consulted. Stable on `at` ties
 * (later in file order wins, matching `latestEntry`'s `>=`).
 */
export function dedupeLatest(entries: LedgerEntry[]): LedgerEntry[] {
  const byKey = new Map<string, LedgerEntry>();
  for (const e of entries) {
    const key = `${e.branch}\u0000${e.kind}`;
    const prev = byKey.get(key);
    if (!prev || e.at >= prev.at) byKey.set(key, e);
  }
  return [...byKey.values()];
}
