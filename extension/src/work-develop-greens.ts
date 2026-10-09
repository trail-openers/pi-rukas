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
import type { WorkState } from "./workflow-state.ts";

export function greenWorkstreamsFromInterruptedDevelop(state: WorkState): Set<string> {
  const green = new Set<string>();
  if (state.pipelineState.currentStep !== "develop") return green;
  if (state.pipelineState.inFlightJobIds.length === 0) return green;
  const log = state.eventLog;
  let start = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "step-started" && e.step === "develop") {
      start = i;
      break;
    }
  }
  const latest = new Map<string, boolean>();
  for (const e of log.slice(start + 1)) {
    if (e.kind === "branch-completed") latest.set(e.workstreamId, e.ok);
  }
  for (const [id, ok] of latest) if (ok) green.add(id);
  return green;
}
