/**
 * work-develop-greens — #1016: which workstreams an interrupted develop
 * attempt already finished green.
 *
 * A develop fan-out persists each workstream's `branch-completed` event as
 * that workstream finishes (work-develop-topological.ts). A crash mid-fan-out
 * therefore leaves the green ones on disk. This reads them back so the resumed
 * step re-dispatches only the workstreams with no green event. Only an
 * interrupted develop qualifies: the step must still be `develop` with an
 * unresolved dispatch marker. A cycle at any other boundary gets full re-entry.
 */
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** #1016 — the reason a fresh green is downgraded to failed when it has no
 *  commits ahead of base (or its check is unreadable). The downgrade REWRITES
 *  the attempt's verdict, so attempt counting skips these events. */
export const GREEN_DOWNGRADE = "no commits ahead of base";

/** #1016 — the events after the last develop step-started (the whole log when
 *  there is none). Shared by the crash-resume greens and the handoff's per-
 *  workstream attempt counts, so both read the same window. */
export function eventsSinceDevelopStart(state: WorkState): WorkEvent[] {
  const log = state.eventLog;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "step-started" && e.step === "develop") return log.slice(i + 1);
  }
  return [...log];
}

/** #1016 — "an interrupted develop": the step is still `develop` and a develop
 *  dispatch was started in the current window. The event log is the durable
 *  signal: clearForResume empties `inFlightJobIds` before the step re-enters,
 *  but keeps every `dispatch-started`. Develop is re-entered only by resume. */
export function isInterruptedDevelop(state: WorkState): boolean {
  if (state.pipelineState.currentStep !== "develop") return false;
  if (state.pipelineState.inFlightJobIds.length > 0) return true;
  // A completed develop is followed by a later step's step-started (adversarial
  // re-entry included): that is a new attempt with feedback, never a crash.
  const window = eventsSinceDevelopStart(state);
  if (window.some((e) => e.kind === "step-started")) return false;
  return window.some((e) => e.kind === "dispatch-started" && e.step === "develop");
}

export function greenWorkstreamsFromInterruptedDevelop(state: WorkState): Set<string> {
  const green = new Set<string>();
  if (!isInterruptedDevelop(state)) return green;
  const latest = new Map<string, boolean>();
  for (const e of eventsSinceDevelopStart(state)) {
    if (e.kind === "branch-completed") latest.set(e.workstreamId, e.ok);
  }
  for (const [id, ok] of latest) if (ok) green.add(id);
  return green;
}
