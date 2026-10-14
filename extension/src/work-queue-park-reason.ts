/**
 * Why a queued group parked, read from its state file. Moved out of
 * work-queue.ts (#1093) to make room for the once-per-invocation start-ref
 * capture; the logic is unchanged.
 */
import { isHostExhaustionFailure } from "./work-driver-exec-error.ts";
import { processAlive } from "./work-driver-resume.ts";
import { deferredLeftoverPath, deferredLeftoverStep } from "./work-queue-parks.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * A live owner is only trusted while its pid still exists. `processAlive`
 * treats an EPERM as alive (the pid exists, owned by another user), which is
 * the safe direction here: mistaking a live cycle for a corpse is what produced
 * the `--restart` advice that would race two drivers on one issue.
 */
function ownerAlive(state: WorkState): boolean {
  const pid = state.owner?.pid;
  return typeof pid === "number" && processAlive(pid);
}

/** The reason suffix `humanActionFor` reads for a gate the host could not run. */
export const HOST_EXHAUSTION_SUFFIX = "host-resource-exhaustion";

export function parkReason(state: WorkState | undefined): { reason: string; failedStep?: string } {
  if (!state) return { reason: "cycle produced no state file" };
  // A `running` status with a live owner is not a park — it is a cycle in
  // flight. Reporting its most recent cap-hit as a terminal reason told the
  // operator a live cycle had failed, and recommended `--restart`.
  if (state.pipelineState.status === "running" && ownerAlive(state)) {
    return { reason: "still running — this is not a terminal state" };
  }
  const cap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  // `lastCompletedStep` is the last step that SUCCEEDED, so reporting it as
  // the failure point names the wrong step. The halt-cascade stamps the real
  // step into the cap (`step-failed:<step>`); prefer that when present. The
  // #753 deferred-creation park has no `step-failed:` prefix by design (it is
  // a deliberate park, not a dispatch failure), so map its step explicitly —
  // the fallback would name `branch` (the last step that succeeded) instead
  // of the dependent phase of develop where the refusal actually happened.
  const capStep =
    cap?.kind === "cap-hit"
      ? cap.cap.startsWith("step-failed:")
        ? cap.cap.slice("step-failed:".length)
        : cap.cap === "deferred-creation:develop"
          ? deferredLeftoverStep()
          : undefined
      : undefined;
  const step = capStep ?? state.pipelineState.lastCompletedStep ?? state.pipelineState.currentStep;
  if (cap?.kind === "cap-hit") {
    // Carry the specific reason so humanActionFor can be specific rather
    // than saying "cap intent-park". #380: the merge hold carries the PR
    // number and whether authority was the blocker.
    let suffix = "";
    if (cap.cap === "intent-park" && state.pipelineState.normalisedSpec?.parkReason) {
      suffix = `:${state.pipelineState.normalisedSpec.parkReason}`;
    } else if (cap.cap === "awaiting-human-merge") {
      const granted = state.pipelineState.mergeHold?.authorityGranted ? "granted" : "no-authority";
      suffix = `:${granted}:pr${state.pipelineState.prNumber ?? 0}`;
      if (state.pipelineState.mergeHold?.evidenceFailureKind === "tooling") suffix += ":tooling";
    } else if (cap.cap === "deferred-creation:develop") {
      // #753 — name the leftover on the reason so the queue action can
      // point at the exact path (salvage-before-rerun, never --restart).
      const path = deferredLeftoverPath(state);
      if (path) suffix = `:${path}`;
    } else if (
      cap.cap.startsWith("verify-failed:") &&
      state.pipelineState.verifyEvidence?.failures.some(isHostExhaustionFailure)
    ) {
      // The gate never ran (the host could not fork): carry that on the
      // reason so the queue action points at the host, not at the diff.
      suffix = `:${HOST_EXHAUSTION_SUFFIX}`;
    }
    return { reason: `cap ${cap.cap}${suffix}`, failedStep: step };
  }
  return { reason: `cycle ended as ${state.pipelineState.status}`, failedStep: step };
}
