/**
 * work-driver-handoff-provider-resume — where a #1243 provider park re-enters.
 *
 * Split from work-driver-handoff.ts (AGENTS.md §12 file-size limit). Pure: the
 * event log in, a step out — the same shape as the other handoff-* helpers, and
 * the reason the handoff module is a thin orchestrator rather than a fourth
 * place that knows how to read a cycle's own history.
 */

import { capStep } from "./headless/caps.ts";
import { lastCap, lastCapIndex } from "./headless/exit-code.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";

/**
 * Where a #1243 provider park resumes: the step whose dispatch died of the
 * endpoint.
 *
 * Two sources, in order of authority, BOTH read through the same helpers the
 * headless result uses (`lastCap` + `capStep`, i.e. the reading
 * `headless/result.ts::failedStepOf` is built from). #1243 fix round — this
 * used to write its own reverse scan for "the last cap-hit" and its own prefix
 * list. That disagreed with `lastCap` in exactly the case that matters: a
 * signal that lands after a step's own cap makes that cap the abort's doing and
 * `lastCapIndex` skips it (#1371), so the old scan would resume the park at a
 * step the cycle is not standing on — and it drifted from `caps.ts`'s template
 * vocabulary, which is the single definition of which cap families name a step.
 * Falls back to the last `step-started` before the park that was not this
 * handoff: `currentStep` is already `handoff` by the time `runHandoff`
 * terminalises, so reading it would make the park resume at its own delivery
 * step and re-post the comment instead of re-running the work.
 *
 * Falls back to `handoff` only when the log records no step at all — a cycle
 * that parked before any step started, where there is nothing to resume.
 */
export function providerParkResumeStep(state: WorkState): WorkStep {
  const cap = lastCap(state);
  const named = cap !== undefined ? capStep(cap) : undefined;
  if (named !== undefined && named !== "handoff") return named;
  const end = cap !== undefined ? lastCapIndex(state) : state.eventLog.length;
  for (let i = end - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === "step-started" && e.step !== "handoff") return e.step;
  }
  return "handoff";
}
