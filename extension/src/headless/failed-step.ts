/**
 * headless/failed-step — the step a cycle that did not merge stopped in. Its own
 * module (not headless/result.ts) so the cycle's cause verdict can read it
 * without a runtime cycle: result.ts projects the verdict, and the verdict
 * (work-driver-cause-for.ts) needs the same step the result reports.
 */

import type { WorkStep } from "../workflow-state-events.ts";
import type { WorkState } from "../workflow-state.ts";
import { capStep } from "./caps.ts";
import { lastCap, lastCapIndex } from "./exit-code.ts";

/**
 * The step a cycle that did not merge stopped in: the step a step-template cap
 * names (`verify-failed:develop`), else the last step started before the last
 * cap hit, else the last step started. The `handoff` step is the driver
 * reporting the stop, never the step that stopped.
 */
export function failedStepOf(state: WorkState): WorkStep | undefined {
  if (state.pipelineState.status === "merged") return undefined;
  const cap = lastCap(state);
  const named = cap !== undefined ? capStep(cap) : undefined;
  if (named) return named;
  const log = state.eventLog;
  const end = cap !== undefined ? lastCapIndex(state) : log.length;
  for (let i = end - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "step-started" && e.step !== "handoff") return e.step;
  }
  return undefined;
}
