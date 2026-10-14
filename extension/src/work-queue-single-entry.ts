/**
 * work-queue-single-entry — #808's single-cycle → QueueEntry mapping.
 *
 * Extracted from work-entry.ts to keep it under the 500-line cap (same
 * pattern as work-queue-summary.ts): the mapping is the queue's DECISION
 * logic for a cycle that never passes through `runWorkQueue`, so it gets its
 * own file next to the shape it builds.
 */

import { trace } from "./trace.ts";
import { mergeQueueSummaryEntry } from "./work-queue-summary.ts";
import { type QueueEntry, humanActionFor } from "./work-queue.ts";
import { lastInterruptReason } from "./work-status-interrupted.ts";
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
  const groupId = `single-${issue}`;
  const issues = state?.issues && state.issues.length > 0 ? state.issues : [issue];

  switch (status) {
    case "merged":
      return { groupId, issues, outcome: "merged" };
    case "running":
      return {
        groupId,
        issues,
        outcome: "not-started",
        reason: "still running — this is not a terminal state",
      };
    default:
      break;
  }

  const cap = [...(state?.eventLog ?? [])].reverse().find((e) => e.kind === "cap-hit");
  const capHit = cap?.kind === "cap-hit" ? cap : undefined;
  const reason = capHit
    ? `cap ${capHit.cap}${
        capHit.cap === "intent-park" && ps?.normalisedSpec?.parkReason
          ? `:${ps.normalisedSpec.parkReason}`
          : ""
      }`
    : status === "interrupted"
      ? `cycle interrupted: ${lastInterruptReason(state?.eventLog ?? []) ?? "no reason recorded"}`
      : `cycle ended as ${status}`;

  // S4a (#1162) — an interrupted cycle is resumable, not terminal: the operator
  // resumes it rather than acting on a failed step.
  if (status === "interrupted") {
    return {
      groupId,
      issues,
      outcome: "parked",
      reason,
      humanAction: `resume with /work ${issue}`,
    };
  }

  const failedStep =
    capHit?.cap.startsWith("step-failed:") === true
      ? capHit.cap.slice("step-failed:".length)
      : undefined;
  return {
    groupId,
    issues,
    outcome: "parked",
    reason,
    failedStep,
    humanAction: humanActionFor(reason, issue),
  };
}

/**
 * #808 — every terminal cycle leaves its outcome in `queue-summary.json`, not
 * just grouped queue runs. Under the old whole-file overwrite a single-issue
 * cycle (which never passes through `runWorkQueue`) never wrote the file at
 * all, so `/work-status` and `/start` were blind to it — and a later grouped
 * run would have erased it anyway. Reads the terminal state the driver just
 * persisted, maps it to the same entry shape the queue builds, and MERGES it
 * into the existing index (never overwriting rows for other issues).
 *
 * Best-effort: a failure at ANY point in this path — reading the state file,
 * mapping it to an entry, merging it into the summary — must never turn a
 * completed cycle into an "unexpected throw": the driver's catch turns a
 * throw into a crash notification and a failed result, and the cycle did not
 * crash. The state file remains the authoritative record.
 */
export async function recordSingleCycleOutcome(repoRoot: string, issue: number): Promise<void> {
  try {
    const entry = await singleCycleQueueEntry(repoRoot, issue);
    if (entry) await mergeQueueSummaryEntry(repoRoot, entry);
  } catch (err) {
    trace(
      `work-driver: could not record single-cycle outcome for #${issue}: ${(err as Error).message?.slice(0, 160)}`,
    );
  }
}
