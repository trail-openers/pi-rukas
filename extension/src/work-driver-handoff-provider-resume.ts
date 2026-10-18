/**
 * work-driver-handoff-provider-resume — where a #1243 provider park re-enters.
 *
 * Split from work-driver-handoff.ts (AGENTS.md §12 file-size limit). Pure: the
 * event log in, a step out — the same shape as the other handoff-* helpers, and
 * the reason the handoff module is a thin orchestrator rather than a fourth
 * place that knows how to read a cycle's own history.
 */

import type { WorkState, WorkStep } from "./workflow-state.ts";

/**
 * Where a #1243 provider park resumes: the step whose dispatch died of the
 * endpoint.
 *
 * Two sources, in order of authority. A step-template cap names its own step in
 * the literal (`step-failed:develop`, `verify-failed:ci`) — that is the driver's
 * own record of what halted, and the router wrote it. Otherwise the last
 * `step-started` before the park that was not this handoff: `currentStep` is
 * already `handoff` by the time `runHandoff` terminalises, so reading it would
 * make the park resume at its own delivery step and re-post the comment instead
 * of re-running the work.
 *
 * Falls back to `handoff` only when the log records no step at all — a cycle
 * that parked before any step started, where there is nothing to resume.
 */
export function providerParkResumeStep(state: WorkState): WorkStep {
  const cap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  if (cap?.kind === "cap-hit") {
    for (const prefix of ["step-failed:", "verify-failed:", "verify-timeout:"] as const) {
      if (cap.cap.startsWith(prefix)) {
        const named = cap.cap.slice(prefix.length) as WorkStep;
        if (named !== "handoff") return named;
      }
    }
  }
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === "step-started" && e.step !== "handoff") return e.step;
  }
  return "handoff";
}
