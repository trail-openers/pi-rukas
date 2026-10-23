/**
 * work-driver-park-memory-host-rows — the POLICY half of a host park row
 * (#1696): what one row is, what it costs to say one, and which rows the signal
 * file is allowed to hold. Pure — no I/O, no clock of its own, no forge.
 *
 * It is a separate module for the same reason as its parent
 * `work-driver-park-memory-host-read.ts`: the sweep's question must stay cheap,
 * and a policy module cannot reach a fetch by accident. Splitting it from the
 * parent is a §12 file-size seam — the parent is the READ (the file, the two
 * ceilings applied to what it parses); this is the ROW (its shape, its bounds,
 * its identity, its eviction order).
 *
 * The one invariant the whole module defends: the writer and the reader must
 * agree on what the file is allowed to hold. Every rule here is therefore
 * reached from BOTH sides — `parseHostParkRows` in the parent on the read, and
 * `recordHostPark` in the sibling writer through the same `parseHostParkRows` —
 * and none of them is duplicated there. Two implementations of "which rows" or
 * "how long a reason" is how a row the writer promised to keep becomes invisible
 * to the guard that was supposed to honour it.
 */

import { REPEAT_PARK_REFUSAL_COUNT } from "./work-driver-park-record.ts";

/**
 * The ceiling on a row's `reason`, in characters. The same reasoning as
 * `EVIDENCE_MAX` in `headless/failure.ts`: it is free text
 * (`cap-hit.parkReason`, the plan gate's verdict) read out of a file in the
 * repository's working tree and rendered into a refusal the host prints, so a
 * row cannot carry an unbounded wall of prose into that message — nor into the
 * row identity a refusal is keyed on.
 *
 * The bar is the READ's, and the writer clips with the same constant so a row
 * stored at the limit and a row stored longer are the SAME row to the reader:
 * `hostRowKey` hashes `reason`, so without the writer's clip a hand-edited long
 * reason would be a different identity from the one the next publish writes, and
 * the duplicate would count separately instead of folding.
 */
export const HOST_PARK_REASON_MAX = 300;

/** The ceiling on the signal FILE, in bytes, checked before it is buffered. */
export const HOST_PARK_FILE_MAX_BYTES = 256 * 1024;

/**
 * How many rows the signal keeps. One row is one (cap, cause, fingerprint), and
 * an issue's causes and edits are bounded in practice — 50 is far past any real
 * cycle's history — so the ceiling exists to stop a file in a repository's
 * working tree growing without bound. Pruning drops the OLDEST first WITHIN each
 * priority band of `prunedHostRows` (armed rows, then everything else), and every
 * remaining row still arms a refusal on its own. The row a publish writes is
 * exempt from the cut: `prunedHostRows` pins the newest-written row so the reader
 * cannot disagree with the writer about which rows the file is allowed to hold.
 *
 * The writer does NOT cap what it puts on disk: `recordHostPark` appends its row
 * to whatever it just read, and the ceiling is applied ONCE, through
 * `parseHostParkRows`/`prunedHostRows`, on both sides of the write — so the file
 * is one row over the ceiling at the moment of the rename and exactly at it the
 * next time anybody reads it.
 */
export const HOST_PARK_MAX_ROWS = 50;

/** One published park: what fired, why, against which issue text, how often. */
export interface HostParkRow {
  cap: string;
  reason: string;
  /** sha256 of the raw issue title + body this park was published against. */
  fingerprint: string;
  /** Host handoffs that PUBLISHED this (cap, reason, fingerprint). */
  deliveredCount: number;
  firstAt: number;
  lastAt: number;
  /** The cycle that last wrote it (`state.startedAt`) — the idempotency key. */
  lastCycleId: number;
}

/**
 * One row's `reason`, clipped to the ceiling. A code-point slice, never a byte
 * one: cutting a surrogate pair in half leaves a lone half in the refusal the
 * operator reads.
 */
export function clipHostParkReason(reason: string): string {
  const chars = Array.from(reason);
  if (chars.length <= HOST_PARK_REASON_MAX) return reason;
  return chars.slice(0, HOST_PARK_REASON_MAX).join("");
}

/**
 * Rows newest first. The ceiling itself is applied in ONE place —
 * `prunedHostRows` — so a file an older writer (or a hand edit) left longer than
 * `HOST_PARK_MAX_ROWS` cannot arm the guard on rows no writer would have kept.
 * This is the plain order that ceiling sorts on, exported for the writer in the
 * sibling module: two implementations of "newest first" is how the writer and
 * the reader start disagreeing about which rows the file is allowed to hold.
 *
 * `lastAt` decides, because it is the clock every age test in this family of
 * modules uses (the guard's and the sweep's both compare `now - lastAt`). Sorting
 * on the cycle id instead would prune by a number that is not a clock: a resumed
 * cycle carries its original `startedAt`, so a row it published — one the reader
 * still believes — would be the first one pruned.
 *
 * The one row this order must not lose is the row a publish just wrote, and
 * `prunedHostRows` pins it; this function is the plain order with no pinning.
 */
export function newestFirstHostRows(rows: HostParkRow[]): HostParkRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) => b.row.lastAt - a.row.lastAt || b.row.lastCycleId - a.row.lastCycleId || a.i - b.i,
    )
    .map((x) => x.row);
}

/**
 * Is this row one the guard is about to act on?
 *
 * The bar is the guard's OWN: `hostParkVerdict` refuses on
 * `deliveredCount >= REPEAT_PARK_REFUSAL_COUNT`, and the prune must keep exactly
 * the rows that predicate can fire on. Rows at `COUNT - 1` are deliberately NOT
 * in the keep band — they are fresh history, and putting them there made the band
 * every row (a cycle publishes at count 1 and only climbs from there), so the
 * priority was silently lost and the prune degenerated to pure recency: the oldest
 * row went, armed or not, which is the behaviour this function exists to remove.
 * A count-1 row is protected by being the row a publish INCREMENTS, not by the
 * ceiling's arithmetic — the writer's re-read keeps it and stamps it with the
 * newest `lastAt` in the file.
 */
function keepWorthy(row: HostParkRow): boolean {
  return row.deliveredCount >= REPEAT_PARK_REFUSAL_COUNT;
}

/**
 * The row a prune must NEVER evict: the one with the newest `lastAt` in the file,
 * the row a publish has just stamped.
 *
 * It needs pinning because a fresh publish lands at count 1 — below `keepWorthy`
 * — so a plain band sort hands the tail of the list to exactly the row the writer
 * has just promised to keep, and the guard silently loses the refusal it will need
 * one publish later. Pinning by identity instead would need the writer to hand the
 * reader its (cap, reason, fingerprint); pinning by `lastAt` needs no argument at
 * all: a row is protected the moment a writer stamps it, and the stamp is the same
 * clock every age test in this family of modules uses — so the writer and the
 * reader cannot fall out over which rows the file holds. The newest row is unique
 * whatever ties it shares with its neighbours (two rows of one timestamp still
 * have one maximum), and it stays at the FRONT of its band, so the cut can never
 * reach it.
 */
function newestHostRow(rows: HostParkRow[]): HostParkRow | undefined {
  let newest: HostParkRow | undefined;
  for (const row of rows) {
    if (newest === undefined || row.lastAt > newest.lastAt) newest = row;
  }
  return newest;
}

/**
 * The identity that decides whether two rows are ONE park. `JSON.stringify` of
 * the triple, not a `\0`-joined string: a NUL inside `reason` — which is free-text
 * `parkReason` that has no character filter by design — made `"a\0b\0c"` and
 * `"a\0b\u0000c\u0000\u0000c"` one key, and two genuinely different parks
 * collapsed into a row whose count belonged to neither. JSON quotes and escapes
 * each field, so a field's own delimiters cannot shift a boundary between fields.
 */
function hostRowKey(row: { cap: string; reason: string; fingerprint: string }): string {
  return JSON.stringify([row.cap, row.reason, row.fingerprint]);
}

/**
 * The rows a prune KEEPS, in the order a prune keeps them: the newest-written
 * row, then ARMED rows (the ones `hostParkVerdict` can refuse on) newest first,
 * then everything else newest first, capped at `max` (default
 * `HOST_PARK_MAX_ROWS`).
 *
 * This is the whole answer to "which 50 rows is this file allowed to hold", and it
 * lives here because BOTH sides must give it: the writer in the sibling module
 * prunes through `parseHostParkRows` before it inserts its own row, and the reader
 * caps what it will believe with the same call. Two policies — the writer pruning
 * on recency while the reader keeps armed rows, or vice versa — is how a row the
 * writer promised to keep is invisible to the guard that was supposed to honour it.
 * Recency alone was the first rule and it lost armedness: on a file at the
 * ceiling, the oldest row went even when it was the one armed row, so a park the
 * operator had already been handed twice stopped being refused for the unrelated
 * reason that fifty other parks had been published since.
 */
export function prunedHostRows(
  rows: HostParkRow[],
  max: number = HOST_PARK_MAX_ROWS,
): HostParkRow[] {
  // ONE priority sort, then one cut. Filling the armed band first and topping it
  // up from the fresh band was the obvious shape and it is wrong under a cap:
  // with `max` below the number of fresh rows, every fresh row is kept, the
  // armed rows are the leftovers, and the final cut drops them — so the single
  // row the guard refuses on was the FIRST thing a capped prune evicted. Sorting
  // by (band, recency) makes eviction go the other way round by construction:
  // the tail of the list is always the least keep-worthy thing in the file.
  const pinned = newestHostRow(rows);
  const band = (row: HostParkRow) => (row === pinned ? -1 : keepWorthy(row) ? 0 : 1);
  return rows
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) =>
        band(a.row) - band(b.row) ||
        b.row.lastAt - a.row.lastAt ||
        b.row.lastCycleId - a.row.lastCycleId ||
        a.i - b.i,
    )
    .slice(0, max)
    .map((x) => x.row);
}

/**
 * Collapse rows that share ONE identity — (cap, reason, fingerprint) — to a single
 * row, keeping the largest count, the oldest `firstAt` and the newest `lastAt`.
 *
 * The writer never produces two such rows, but the file is not only the writer's:
 * a hand edit, a crash between the tmp write and the rename, or a row copied
 * between issues can leave duplicates. Left alone, one publish then increments one
 * row by one while the armed twin sits there, and the guard's answer depends on
 * which of the two it happened to read first — a count the operator is quoting
 * stops being the number of publishes. Deduplicating at parse time means every
 * reader, the sweep and the writer all see one row per identity, and the identity
 * stays exactly as unique as the guard's key.
 */
export function dedupeHostRows(rows: HostParkRow[]): HostParkRow[] {
  const byKey = groupByIdentity(rows);
  const merged: HostParkRow[] = [];
  for (const group of byKey.values()) {
    const head = group[0];
    if (head === undefined) continue;
    if (group.length === 1) {
      merged.push(head);
      continue;
    }
    // One park, one row: largest count, oldest `firstAt`, newest `lastAt`.
    // Mutable accumulation rather than a spread-reduce: the accumulating spread
    // copies the whole row on every step, and biome flags it.
    const one: HostParkRow = { ...head };
    for (const r of group) {
      one.deliveredCount = Math.max(one.deliveredCount, r.deliveredCount);
      one.firstAt = Math.min(one.firstAt, r.firstAt);
      one.lastAt = Math.max(one.lastAt, r.lastAt);
      one.lastCycleId = Math.max(one.lastCycleId, r.lastCycleId);
    }
    merged.push(one);
  }
  return newestFirstHostRows(merged);
}

/**
 * Collapse rows of one identity for a WRITE, where the identity being written
 * (`mine`) is known and one of the duplicates is the row about to be counted.
 *
 * `dedupeHostRows` is the read-side answer and it is right for a reader; a writer
 * cannot use it as-is, because collapsing a count-3 row and the row this cycle is
 * publishing into one row whose `lastCycleId` is the MAXIMUM would stamp the
 * merged row with a cycle that never published the count-3 half — and a merged row
 * that carries this cycle's id makes the write think it has already published,
 * silently dropping the increment. So the group this cycle belongs to is collapsed
 * into the row the cycle owns (its own id wins), and every other identity is left
 * to the plain rule. Keeps max count, oldest `firstAt`, newest `lastAt` either way.
 */
export function dedupeHostRowsForWrite(
  rows: HostParkRow[],
  mine: { cap: string; reason: string; fingerprint: string },
  cycleId: number,
): HostParkRow[] {
  const byKey = groupByIdentity(rows);
  const merged: HostParkRow[] = [];
  for (const group of byKey.values()) {
    const first = group[0];
    if (first === undefined) continue;
    if (group.length === 1) {
      merged.push(first);
      continue;
    }
    // Mutable accumulation rather than a spread-reduce (see `dedupeHostRows`).
    const head: HostParkRow = { ...first };
    for (const r of group) {
      head.deliveredCount = Math.max(head.deliveredCount, r.deliveredCount);
      head.firstAt = Math.min(head.firstAt, r.firstAt);
      head.lastAt = Math.max(head.lastAt, r.lastAt);
      head.lastCycleId = Math.max(head.lastCycleId, r.lastCycleId);
    }
    // The cycle owns the row when its id is on one of the duplicates, or when
    // this is the identity it is publishing.
    const owned = group.some((r) => r.lastCycleId === cycleId);
    const publishing =
      head.cap === mine.cap && head.reason === mine.reason && head.fingerprint === mine.fingerprint;
    merged.push(owned || publishing ? { ...head, lastCycleId: cycleId } : head);
  }
  return newestFirstHostRows(merged);
}

/** Rows bucketed by the identity that makes two rows one park. */
function groupByIdentity(rows: HostParkRow[]): Map<string, HostParkRow[]> {
  const byKey = new Map<string, HostParkRow[]>();
  for (const row of rows) {
    const key = hostRowKey(row);
    const seen = byKey.get(key);
    if (seen) seen.push(row);
    else byKey.set(key, [row]);
  }
  return byKey;
}
