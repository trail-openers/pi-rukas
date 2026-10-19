/**
 * work-queue-single-entry — #808's single-cycle → QueueEntry mapping.
 *
 * Extracted from work-entry.ts to keep it under the 500-line cap (same
 * pattern as work-queue-summary.ts): the mapping is the queue's DECISION
 * logic for a cycle that never passes through `runWorkQueue`, so it gets its
 * own file next to the shape it builds.
 */

import { causeForCycle, queueCauseAction } from "./work-driver-cause-render.ts";
import { parkReason } from "./work-queue-park-reason.ts";
import { type QueueEntry, humanActionFor } from "./work-queue.ts";
import { lastInterruptReason } from "./work-status-interrupted.ts";
import { isProviderPark } from "./workflow-state-events-interrupted.ts";
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
  // #1421 fix round — the cap reason comes from the queue's OWN reader, not a
  // local string. This path used to spell `cap <cap>` itself, so every suffix
  // `parkReason` carries for `humanActionFor` (`:build-residue`,
  // `:host-resource-exhaustion`, the awaiting-human-merge PR/authority tag,
  // the #753 leftover path) was missing on the single-group build, and a
  // build-residue park got the fork advice or the "inspect the diff" advice.
  // `parkReason`'s own `running` branch is unreachable here (the switch above
  // returns first), and its `lastCompletedStep` fallback is not used: this
  // path derives `failedStep` from the `step-failed:` cap, so only the reason
  // string is taken.
  const reason = capHit
    ? parkReason(state).reason
    : status === "interrupted"
      ? `cycle interrupted: ${lastInterruptReason(state?.eventLog ?? []) ?? "no reason recorded"}`
      : `cycle ended as ${status}`;

  // #1243 fix round — a PROVIDER park takes its reason from the CAP, not from
  // the interrupt reason, and therefore carries the provider action text the
  // multi-issue path gets from `humanActionFor`. Its cap is
  // `provider-unavailable`; an interrupted-status reason ("cycle interrupted:
  // provider") matches none of `humanActionFor`'s rules and fell through to
  // "inspect .pi/work-state/N.json and re-run /work N --restart" — the generic
  // advice for a real failure, and the one verb this park exists to avoid.
  // A genuine signal/timeout interrupt has no such cap and keeps the S4a
  // resume wording below.
  if (state !== undefined && isProviderPark(state)) {
    const provider = parkReason(state).reason;
    return {
      groupId,
      issues,
      outcome: "parked",
      reason: provider,
      humanAction: humanActionFor(provider, issue, issues),
    };
  }

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
  // #1675 "inspect the diff" was the one line every verify park got. A verify
  // park is judged from its evidence, so its line states the class and reason.
  const cause =
    state !== undefined && capHit?.cap.startsWith("verify-failed:") === true
      ? causeForCycle(state)
      : undefined;
  return {
    groupId,
    issues,
    outcome: "parked",
    reason,
    failedStep,
    humanAction: cause ? queueCauseAction(cause) : humanActionFor(reason, issue),
  };
}
