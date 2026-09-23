/**
 * work-queue-summary — persistence for the end-of-queue report.
 *
 * Extracted from work-queue.ts to keep that module under the 500-line cap
 * (same pattern as work-queue-overlap.ts). The summary is the most
 * actionable state a queue run produces — which groups parked, why, and
 * what a human has to do about each — and used to exist only in the
 * scrollback of the session that produced it, so walking away and coming
 * back meant it was gone (#382).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { QueueEntry, QueueSummary } from "./work-queue.ts";
import { workStateDir } from "./workflow-state.ts";

/** Where the last queue run's outcome is kept, for `/work-status` and `/start`. */
export function queueSummaryPath(repoRoot: string): string {
  return path.join(workStateDir(repoRoot), "queue-summary.json");
}

/**
 * Merge finished cycle outcomes into the on-disk queue summary.
 *
 * #808 — the summary is an ACCUMULATING index, not a snapshot of the last
 * queue run. Both write paths merge through here, symmetrically: single-issue
 * cycles (which never pass through `runWorkQueue`) pass one entry, and a
 * grouped queue run passes its run's entries with its own `notStarted` list.
 * The read-modify-write is: read the existing entries, replace only the rows
 * this run owns (keyed by issue number — `groupId` is run-scoped and a re-run
 * of the same issues legitimately gets a new group id), keep every other row
 * in its original order with its original fields, recompute the totals over
 * the union, and set `notStarted` to THIS run's list (it is run-scoped: it
 * names the groups the run "never reached", which is always true for a run
 * whose summary is being replaced). Without the merge a grouped run would
 * erase the rows earlier single-issue cycles recorded — the #765 incident
 * shape, reversed.
 *
 * Still tmp+rename, so a crash mid-write cannot leave a half-parsed file.
 */
export async function mergeQueueSummaryEntries(
  repoRoot: string,
  entries: QueueEntry[],
  notStarted: string[] = [],
  at = Date.now(),
): Promise<void> {
  const file = queueSummaryPath(repoRoot);
  const previous = await readQueueSummary(repoRoot);
  const owned = new Set(entries.flatMap((e) => e.issues));
  const kept = (previous?.entries ?? []).filter((e) => !e.issues.some((n) => owned.has(n)));
  const union = [...kept, ...entries];
  // `at` tracks the last write, mirroring the pre-#808 shape the readers
  // (`/work-status` index, `/start`) render; entries keep their own fields.
  const merged: QueueSummary = {
    entries: union,
    merged: union.filter((e) => e.outcome === "merged").length,
    parked: union.filter((e) => e.outcome === "parked").length,
    refused: union.filter((e) => e.outcome === "not-started").length,
    notStarted,
  };
  await writeQueueSummary(repoRoot, merged, at);
}

/** Merge a single finished cycle's outcome (the one-entry call shape). */
export async function mergeQueueSummaryEntry(
  repoRoot: string,
  entry: QueueEntry,
  at = Date.now(),
): Promise<void> {
  await mergeQueueSummaryEntries(repoRoot, [entry], [], at);
}

/**
 * Persist the queue outcome so it survives the session that produced it.
 * Best-effort: a failed write must not turn a completed queue into an error.
 */
export async function writeQueueSummary(
  repoRoot: string,
  summary: QueueSummary,
  at = Date.now(),
): Promise<void> {
  const file = queueSummaryPath(repoRoot);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // tmp+rename so a crash mid-write cannot leave a half-parsed summary.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ at, ...summary }, null, 2));
    await fs.rename(tmp, file);
  } catch (err) {
    trace(`work-queue: could not persist queue summary: ${(err as Error).message?.slice(0, 160)}`);
  }
}

/** Read back the last queue run's outcome, or undefined if there is none. */
export async function readQueueSummary(repoRoot: string) {
  try {
    const raw = await fs.readFile(queueSummaryPath(repoRoot), "utf8");
    const parsed = JSON.parse(raw) as QueueSummary & { at: number };
    return Array.isArray(parsed.entries) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
