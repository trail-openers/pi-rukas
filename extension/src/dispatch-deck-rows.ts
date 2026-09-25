/**
 * Deck row rendering (moved verbatim from dispatch-deck.ts when that module
 * hit the 500-line limit — all the row-shape code lives here so the deck's
 * state/map module stays focused on entry lifecycle).
 *
 * Owns the STALE threshold (PI_ENSEMBLE_STALE_THRESHOLD_MS, default 15 min),
 * the per-row elapsed/stale/hint projection, and the `buildLines` /
 * `buildLinesBatchOnly` projections that dispatch-deck.ts's composite widget
 * factory reads (dispatch-deck.ts calls them with its own private maps).
 * The orphan-member contract and the superset-invariant test
 * (test-dispatch-deck.ts block 8 / 12c) both reference these functions.
 */

import type { BatchDeckEntry, DeckEntry } from "./dispatch-deck.ts";
import type { RunningState } from "./progress.ts";
import { formatElapsed } from "./progress.ts";

const STALE_THRESHOLD_MS = (() => {
  const env = Number(process.env.PI_ENSEMBLE_STALE_THRESHOLD_MS);
  return Number.isFinite(env) && env >= 1000 ? env : 15 * 60_000;
})();

const HINT_MAX = 50;

function isStale(entry: { state: RunningState; startedAt: number }, now: number): boolean {
  const last = entry.state.lastEventAt ?? entry.startedAt;
  return now - last >= STALE_THRESHOLD_MS;
}

function entryLabel(e: { label: string; state: RunningState }): string {
  return e.label || (e.state.tag ? `${e.state.role}[${e.state.tag}]` : e.state.role);
}

function truncateHint(s: string): string {
  const oneLine = s.replaceAll(/\s+/g, " ").trim();
  if (oneLine.length <= HINT_MAX) return oneLine;
  return `${oneLine.slice(0, HINT_MAX - 1).trimEnd()}…`;
}

function formatRowCore(
  entry: { label: string; state: RunningState; startedAt: number },
  now: number,
): string {
  const elapsedMs = Math.max(0, now - entry.startedAt);
  const parts: string[] = [entryLabel(entry), formatElapsed(elapsedMs)];
  if (entry.state.lastToolName) {
    parts.push(
      entry.state.toolUses > 1
        ? `${entry.state.lastToolName} (#${entry.state.toolUses})`
        : entry.state.lastToolName,
    );
    if (entry.state.lastToolHint) parts.push(truncateHint(entry.state.lastToolHint));
  }
  if (isStale(entry, now)) {
    parts.push(
      `STALE (no progress ${formatElapsed(now - (entry.state.lastEventAt ?? entry.startedAt))})`,
    );
  }
  return parts.join(" ");
}

export function formatRow(
  entry: { label: string; state: RunningState; startedAt: number },
  now: number = Date.now(),
): string {
  return `${isStale(entry, now) ? "⚠" : "⏳"} ${formatRowCore(entry, now)}`;
}

export function formatBatchRow(
  batch: { label: string; size: number; completed: number; startedAt: number },
  now: number = Date.now(),
): string {
  const running = Math.max(0, batch.size - batch.completed);
  return `⏳ batch[${batch.label}] ${formatElapsed(Math.max(0, now - batch.startedAt))} · ${batch.completed}/${batch.size} done${running > 0 ? ` · ${running} running` : ""}`;
}

/** Top-level deck rows: batch headers + standalone (non-batched) entries,
 *  in insertion order. Batched members are NOT included — they render as
 *  their own per-job rows in the composite's row projection (#834), so
 *  including them here would double-render them. It is a strict superset
 *  of `buildLinesBatchOnly`'s output (both contain batch headers; this
 *  adds standalone rows).
 *
 *  Orphan-member contract (fail-open, deliberate): an entry whose `batchKey`
 *  names a batch that was never registered — or was cleared while its members
 *  were still alive — is classified here as standalone and renders as a
 *  top-level row. This is NOT logged, and if the batch is later (re)registered
 *  the same entry silently flips back to a batch member. Test
 *  test-dispatch-deck.ts block 8 pins this behaviour; treat it as the
 *  documented contract, not a bug. */
export function buildLines(
  entries: Map<string, DeckEntry>,
  batches: Map<string, BatchDeckEntry>,
  now: number = Date.now(),
): string[] {
  const standalone: DeckEntry[] = [];
  for (const e of entries.values()) {
    if (!e.batchKey || !batches.has(e.batchKey)) {
      standalone.push(e);
    }
  }
  type TL = { kind: "batch"; b: BatchDeckEntry } | { kind: "single"; e: DeckEntry };
  const tl: TL[] = [
    ...[...batches.values()].map((b) => ({ kind: "batch" as const, b })),
    ...standalone.map((e) => ({ kind: "single" as const, e })),
  ];
  tl.sort(
    (a, b) => (a.kind === "batch" ? a.b.seq : a.e.seq) - (b.kind === "batch" ? b.b.seq : b.e.seq),
  );
  const lines: string[] = [];
  for (const item of tl) {
    if (item.kind === "batch") {
      lines.push(formatBatchRow(item.b, now));
    } else {
      lines.push(formatRow(item.e, now));
    }
  }
  return lines;
}

/** The composite's Text projection: batch header rows only.
 *  Members have their own per-job rows (one Text row per running entry
 *  in the composite, #834), so including them here would render each
 *  batch member twice. This is a strict subset of `buildLines`' output
 *  (both contain batch headers; `buildLines` also adds standalone rows).
 *  Exported for the superset-invariant test (test-dispatch-deck.ts block
 *  12c), which compares it against `buildLines` at a fixed `now` — the
 *  test cannot reconstruct this from the exported surface without
 *  sampling `Date.now()` twice and racing a 1 ms elapsed-time tick
 *  (flaky on CI). */
export function buildLinesBatchOnly(
  batches: Map<string, BatchDeckEntry>,
  now: number = Date.now(),
): string[] {
  const lines: string[] = [];
  for (const b of batches.values()) {
    lines.push(formatBatchRow(b, now));
  }
  return lines;
}
