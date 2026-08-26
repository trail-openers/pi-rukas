/**
 * workflow-state-update — the state constructors and mutators for the
 * driver's WorkState: `initialState` (fresh cycle), `appendEvent`
 * (log append + caller-side pipelineState patch, no persist) and
 * `detectInconsistencies` (resume-time coherence check).
 *
 * Split out of `workflow-state-schema.ts` for module-size hygiene
 * (AGENTS.md §12): the schema file holds the type definitions and the
 * step table; this file holds the functions that operate on state.
 * Both re-export the shared types from the schema so existing imports
 * of `workflow-state.ts` keep working unchanged.
 */

import type { WorkEvent } from "./workflow-state-events.ts";
import { WORK_STATE_SCHEMA_VERSION, type WorkState } from "./workflow-state-schema.ts";

/**
 * Build an initial state for a fresh /work cycle. Caller must `writeState`
 * to persist.
 */
export function initialState(issue: number, now: number = Date.now()): WorkState {
  return {
    schemaVersion: WORK_STATE_SCHEMA_VERSION,
    resumable: false,
    issue,
    startedAt: now,
    updatedAt: now,
    pipelineState: {
      currentStep: "explore",
      inFlightJobIds: [],
      worktrees: {},
      reviewRound: 0,
      ciRetryCount: 0,
      plumbReports: [],
      status: "running",
    },
    eventLog: [],
  };
}

/**
 * Append an event (and patch pipelineState on the caller's side) in one
 * atomic state update. Does NOT persist — callers `await writeState(...)`
 * after batching their event(s) + pipelineState mutation; persisting
 * between events would expose intermediate states to a concurrent reader.
 */
export function appendEvent(state: WorkState, ...events: WorkEvent[]): WorkState {
  return {
    ...state,
    eventLog: [...state.eventLog, ...events],
  };
}

/**
 * Detect inconsistency: pipelineState says we have in-flight jobs but the
 * eventLog has no matching dispatch-started; or pipelineState.currentStep
 * disagrees with the last step-started. The driver calls this on resume;
 * returns human-readable inconsistencies, empty if coherent.
 */
export function detectInconsistencies(state: WorkState): string[] {
  const out: string[] = [];
  const lastStepStarted = [...state.eventLog]
    .reverse()
    .find((e): e is Extract<WorkEvent, { kind: "step-started" }> => e.kind === "step-started");
  if (lastStepStarted && lastStepStarted.step !== state.pipelineState.currentStep) {
    // Allow forward drift — pipelineState moved ahead of the last step-started
    // (rare but legal for PM-judgment steps that collapse without emitting).
    // Backward drift is the bug we care about.
    // For v1 we just report; callers can decide.
    out.push(
      `pipelineState.currentStep=${state.pipelineState.currentStep} but last step-started was ${lastStepStarted.step}`,
    );
  }
  // Every inFlightJobId should have a dispatch-started in the log without a
  // matching dispatch-completed / dispatch-failed*.
  for (const jobId of state.pipelineState.inFlightJobIds) {
    const started = state.eventLog.find(
      (e) =>
        (e.kind === "dispatch-started" ||
          e.kind === "dispatch-completed" ||
          e.kind === "dispatch-failed" ||
          e.kind === "dispatch-failed-provider") &&
        "jobId" in e &&
        e.jobId === jobId,
    );
    if (!started) {
      out.push(`pipelineState.inFlightJobIds includes ${jobId} but log has no record of it`);
    }
  }
  return out;
}
