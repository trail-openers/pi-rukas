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

/** #1421 — the suffix for a gate declined by git-ignored build output. */
export const BUILD_RESIDUE_SUFFIX = "build-residue";

/**
 * #1101 — queue-raised park reasons, recognised here as well as in
 * `work-queue-cap.ts`.
 *
 * These three never came from a cycle: the queue raised them about a group it
 * never dispatched. `parkReason` reads a STATE FILE, and for these groups there
 * is none — so the shapes below are not reasons this function produces, they
 * are the reasons it must not mistake for one. A queue-level park writes an
 * entry with no state file behind it, and a renderer or a `/work-status` reader
 * that walks in expecting `cap <cycle-cap>` + a step to inspect will send the
 * operator to a diff that was never written. `isQueueLevelPark` is the single
 * test for that, shared so the two places cannot drift.
 */
export const QUEUE_PARK_REASONS = [
  "dependency-parked",
  "dependency-timeout",
  "dependency-cycle",
] as const;

/**
 * Was this reason raised by the queue about a group it never dispatched?
 *
 * `cross-group-conflict` is deliberately NOT in the list: the same cap name is
 * raised by the reactive plan-time check, which runs INSIDE a cycle that had
 * already dispatched. Only the queue-level sighting of it produces no state
 * file, and `work-queue-cap.ts` distinguishes those by route, not by name — so
 * this predicate stays honest by naming only the reasons no cycle ever raises.
 */
export function isQueueLevelPark(reason: string | undefined): boolean {
  if (!reason) return false;
  return QUEUE_PARK_REASONS.some((cap) => new RegExp(`\\bcap ${cap}\\b`).test(reason));
}

export function parkReason(state: WorkState | undefined): { reason: string; failedStep?: string } {
  if (!state) return { reason: "cycle produced no state file" };
  // #1101 — a group the QUEUE parked has no state file of its own, so this
  // function is never the right reader for it. Guarded rather than assumed:
  // `runGroup` can report `started: false` for a group whose on-disk state
  // belongs to a DIFFERENT cycle, and reporting that cycle's cap as this
  // group's reason is how a live cycle's mid-flight cap got printed as a
  // terminal failure with `--restart` advice that would race it.
  //
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
    } else if (
      cap.cap.startsWith("verify-") &&
      // #1421 — same treatment for a gate declined by build output: the
      // reason string is what `humanActionFor` matches on, and without the
      // suffix it gets the "inspect the diff" advice.
      //
      // #1421 fix round — read the gate's STRUCTURED decline, not a substring
      // of the failure strings. The label lives in prose whose path text is
      // not ours (a residue path, a quoted log line), and a park that merely
      // MENTIONED it used to earn the build advice when the gate had in fact
      // judged the code. The boolean is the consolidated gate's own decision.
      state.pipelineState.verifyEvidence?.buildResidueOnly === true
    ) {
      suffix = `:${BUILD_RESIDUE_SUFFIX}`;
    }
    return { reason: `cap ${cap.cap}${suffix}`, failedStep: step };
  }
  return { reason: `cycle ended as ${state.pipelineState.status}`, failedStep: step };
}
