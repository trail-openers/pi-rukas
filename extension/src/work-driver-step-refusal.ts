/**
 * work-driver-step-refusal — #1016: the workstreams the driver REFUSED in the
 * current run of a fanned-out step.
 *
 * A refusal (no worktree recorded, an unsafe reuse, a containment violation)
 * is a driver decision, not a provider fault. It is recorded as a
 * `branch-completed` carrying `refused: true`. For N=1 no `branches-converged`
 * follows, so the step router cannot see it through the fan-out verdicts; this
 * scan reads the refusal directly. Bounded by the last `step-started` for the
 * step, so a refusal from an earlier attempt of the same step cannot leak in.
 */
import type { WorkEvent, WorkStep } from "./workflow-state-events.ts";

export interface StepRefusal {
  id: string;
  reason: string;
}

export function refusedWorkstreams(events: readonly WorkEvent[], step: WorkStep): StepRefusal[] {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === "step-started" && e.step === step) {
      start = i;
      break;
    }
  }
  const out: StepRefusal[] = [];
  for (let i = start; i < events.length; i++) {
    const e = events[i];
    if (e?.kind === "branch-completed" && e.step === step && e.refused === true) {
      out.push({ id: e.workstreamId, reason: e.error ?? "refused by the driver" });
    }
  }
  return out;
}
