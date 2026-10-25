/**
 * work-driver-handoff-terminal — how a finished handoff terminalises the cycle
 * (#1243, #754, #1560), split out of `work-driver-handoff.ts` under §12.
 *
 * The handoff step is terminal, and "terminal" is a choice with three answers.
 * Most parks end as `handoff`; a halt that happened MID-FLIGHT — the cycle was
 * killed on a bound the driver chose, not concluded on its merits — ends as
 * `aborted`; and a provider outage ends as `interrupted` with reason `provider`,
 * because that is the one status the driver re-enters without a fight.
 *
 * ## Why the provider park is not a `handoff`
 *
 * Every surface that explains a `provider-unavailable` cap (`explainCap`,
 * `humanActionFor`, docs/troubleshooting.md) tells the caller to re-run
 * `/work N` so the halted step re-enters. A `handoff` status REFUSES exactly that
 * ("already terminated as handoff … re-run with --restart"), and `--restart`
 * wipes the state file and rebuilds finished steps — the opposite of the advice,
 * and a re-run that pays again for work the cycle already did. So the endpoint's
 * park keeps the delivered comment and label and takes the re-enterable status,
 * with the step that halted as its resume point.
 *
 * ## What the resume point may never be
 *
 * Never `handoff` itself: re-entry would re-run the delivery, not the step that
 * failed. The cap names one when it can (`step-failed:<step>` and
 * `verify-failed:<step>` carry it in the literal); otherwise it is the last
 * `step-started` that was not this handoff — the same reading
 * `headless/result.ts::failedStepOf` uses, so the two surfaces cannot disagree
 * about where the cycle stopped.
 */

import { providerParkResumeStep } from "./work-driver-handoff-provider-resume.ts";
import type { WorkState } from "./workflow-state.ts";
import { parkProviderInterrupt } from "./workflow-state.ts";

/** The cap shapes that killed a child mid-run rather than concluding a step. */
function isMidFlightCap(cap: string | undefined): boolean {
  if (cap === undefined) return false;
  return (
    cap === "spawn-backstop" ||
    // #754 — a plan-timeout kill is a mid-flight halt like spawn-backstop: the
    // cycle parked on a bound we chose, and the terminal status says so.
    cap === "plan-timeout" ||
    // #1560 — the per-child run bound ended a child: the same kind of halt.
    cap.startsWith("child-timeout:") ||
    // A watchdog kill (loop detector, token budget) is a halt, not a conclusion.
    cap === "loop-detected" ||
    cap === "token-budget" ||
    cap.startsWith("step-failed:")
  );
}

/** The last cap-hit's shape, or undefined when the cycle reached handoff without one. */
export function lastCapShape(state: WorkState): string | undefined {
  const last = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  return last?.kind === "cap-hit" ? last.cap : undefined;
}

/**
 * Set the cycle's terminal status from the cap that ended it, and re-park a
 * provider outage as the one status the driver re-enters. Pure apart from the
 * timestamp the provider park records.
 */
export function terminaliseHandoff(state: WorkState, at: number): WorkState {
  const cap = lastCapShape(state);
  if (cap === "provider-unavailable") {
    return parkProviderInterrupt(state, providerParkResumeStep(state), at);
  }
  if (isMidFlightCap(cap)) {
    return {
      ...state,
      pipelineState: { ...state.pipelineState, status: "aborted" },
    };
  }
  return {
    ...state,
    pipelineState: { ...state.pipelineState, status: "handoff" },
  };
}
