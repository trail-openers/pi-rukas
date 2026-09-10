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
import type { QueueSummary } from "./work-queue.ts";
import { workStateDir } from "./workflow-state.ts";

/** Where the last queue run's outcome is kept, for `/work-status` and `/start`. */
export function queueSummaryPath(repoRoot: string): string {
  return path.join(workStateDir(repoRoot), "queue-summary.json");
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
