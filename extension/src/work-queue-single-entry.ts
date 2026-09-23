/**
 * work-queue-single-entry — #808's single-cycle → QueueEntry mapping.
 *
 * Extracted from work-entry.ts to keep it under the 500-line cap (same
 * pattern as work-queue-summary.ts): the mapping is the queue's DECISION
 * logic for a cycle that never passes through `runWorkQueue`, so it gets its
 * own file next to the shape it builds.
 */

import { type QueueEntry, humanActionFor } from "./work-queue.ts";
import { type WorkState, readState } from "./workflow-state.ts";

/**
 * #808 — read the terminal state the driver just persisted and build the
 * `QueueEntry` a single-issue cycle records in the accumulating queue summary
 * (which `runWorkQueue`'s full-overwrite never wrote for single-issue paths).
 *
 * Returns undefined when there is no state to describe — the caller leaves
 * the summary untouched rather than writing a phantom row.
 */
export async function singleCycleQueueEntry(
  repoRoot: string,
  issue: number,
): Promise<QueueEntry | undefined> {
  const state = (await readState(repoRoot, issue).catch(() => undefined)) as WorkState | undefined;
  const ps = state?.pipelineState;
  const status = ps?.status;
  if (status === undefined) return undefined;
  const issues = state?.issues && state.issues.length > 0 ? state.issues : [issue];
  const cap = [...(state?.eventLog ?? [])].reverse().find((e) => e.kind === "cap-hit");
  const capHit = cap?.kind === "cap-hit" ? cap : undefined;
  const failedStep = capHit
    ? capHit.cap.startsWith("step-failed:")
      ? capHit.cap.slice("step-failed:".length)
      : undefined
    : undefined;
  const reason =
    capHit?.kind === "cap-hit"
      ? `cap ${capHit.cap}${
          capHit.cap === "intent-park" && ps?.normalisedSpec?.parkReason
            ? `:${ps.normalisedSpec.parkReason}`
            : ""
        }`
      : `cycle ended as ${status}`;
  return status === "merged"
    ? { groupId: `single-${issue}`, issues, outcome: "merged" }
    : status === "running"
      ? {
          groupId: `single-${issue}`,
          issues,
          outcome: "not-started",
          reason: "still running — this is not a terminal state",
        }
      : {
          groupId: `single-${issue}`,
          issues,
          outcome: "parked",
          reason,
          failedStep,
          humanAction: humanActionFor(reason, issue),
        };
}
