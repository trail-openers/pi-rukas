/**
 * work-status-interrupted — the view of an `interrupted` /work cycle (S4a, #1162).
 *
 * An interrupted cycle is neither running nor terminal: the driver can resume
 * it on re-entry. Shared by `/work-status` (single cycle), the multi-cycle
 * index, and the queue summary entry, so all three name the same reason.
 */

import path from "node:path";
import { isProviderPark } from "./workflow-state-events-interrupted.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import { type WorkState, workStateDir } from "./workflow-state.ts";

/** The reason recorded by the most recent `interrupted` event, if any. */
export function lastInterruptReason(eventLog: WorkEvent[]): string | undefined {
  const e = [...eventLog]
    .reverse()
    .find((x): x is Extract<WorkEvent, { kind: "interrupted" }> => x.kind === "interrupted");
  return e?.reason;
}

/** Single-cycle status block for an interrupted cycle. */
export function renderInterruptedStatus(state: WorkState, repoRoot: string): string {
  const ps = state.pipelineState;
  const reason = lastInterruptReason(state.eventLog) ?? "(no reason recorded)";
  // #1243 fix round — a provider park is PARKED, not merely interrupted: the
  // endpoint stopped it, nothing was judged, and the operator (or a headless
  // caller) re-runs it once the endpoint answers. The generic interrupted row
  // below renders it as `INTERRUPTED (resumable)` with no verdict and no
  // cap — which read as "the signal got it", and gave no advice about the
  // endpoint or about the one verb that is wrong here. Same shape, plus the
  // verdict `explainCap` gives every other surface (the in-chat handoff, the
  // GitHub body, the queue) so the three cannot disagree about the advice.
  if (isProviderPark(state)) {
    return [
      `/work #${state.issue} — PARKED (resumable: provider unavailable)`,
      `  reason: ${reason}`,
      `  current step: ${ps.currentStep}${ps.lastCompletedStep ? ` (last completed: ${ps.lastCompletedStep})` : ""}`,
      `  resume: /work ${state.issue}`,
      "  do NOT pass --restart — the halted step re-enters and finished steps are not rebuilt",
      "",
      `state file: ${path.join(workStateDir(repoRoot), `${state.issue}.json`)}`,
    ].join("\n");
  }
  return [
    `/work #${state.issue} — INTERRUPTED (resumable)`,
    `  reason: ${reason}`,
    `  current step: ${ps.currentStep}${ps.lastCompletedStep ? ` (last completed: ${ps.lastCompletedStep})` : ""}`,
    `  resume: /work ${state.issue}`,
    "",
    `state file: ${path.join(workStateDir(repoRoot), `${state.issue}.json`)}`,
  ].join("\n");
}
