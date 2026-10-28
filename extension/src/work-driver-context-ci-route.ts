import type { StepDecision } from "./work-driver-context.ts";
/**
 * work-driver-context-ci-route — the ci-tier half of the `nextStep()` table,
 * split out of work-driver-context.ts (#1879 fix round, AGENTS.md §12 size cap:
 * pure move of the two failure arms plus one new arm, no behaviour change
 * beyond the canary branch it carries).
 *
 * Why a separate module rather than more lines in `work-driver-context.ts`:
 * those two arms are the whole difference between a green merge and a develop
 * re-run, and they now read three facts — the event, the retry count, and
 * whether the tier's evidence names an unsound compiler. Keeping them beside
 * the rest of the transition table made that file the largest in the driver
 * and the routing rule hard to see; `nextStep()` delegates here and the rest
 * of the table is untouched.
 *
 * The rule these arms enforce:
 *
 *   - A failing full verification is a failing verification. `runCi` runs
 *     `.pi/verify-cmd-full` before watching CI — strictly more than CI does —
 *     and on failure appends `verify-full-status` WITHOUT a `ci-status`. With
 *     no branch here the tail fell through to the linear table, where
 *     `ci: "merged"`, so a diff whose full verification failed went to merged
 *     on every cycle (#279's regression). It is routed identically to
 *     `ci-status` and deliberately NOT merged into it: the two events mean
 *     different things and `verify-full-status` carries the `evidenceTail`
 *     that says what actually broke.
 *   - #1879 — unless the failure IS the compiler canary. The ci step raises the
 *     `toolchain-unsound` cap itself, so the normal tail routes on that cap-hit
 *     from the cap branch above; this arm is the backstop for a tail that
 *     reached the router without one (a replayed or older state file). A
 *     compiler that was proven unable to judge is not a CI failure: re-entering
 *     develop dispatches a developer against code the tier never judged, and
 *     burns a ci retry doing it.
 */
import { isToolchainUnsoundFailure } from "./work-driver-toolchain-canary.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * Route one ci-tier event. `MAX_CI_RETRIES` and the `StepDecision` shape come
 * from the module that owns the transition table; this module owns only these
 * two arms, and returns `undefined` for any event it does not judge so the
 * caller's own table stays the single place the other routes live.
 */
export function routeCiTier(
  lastEvent: WorkEvent | undefined,
  ps: WorkState["pipelineState"],
  maxCiRetries: number,
): StepDecision | undefined {
  if (lastEvent?.kind === "verify-full-status" && lastEvent.status === "failure") {
    if (isToolchainUnsoundFailure(lastEvent.evidenceTail ?? ""))
      return { kind: "step", step: "handoff" };
    if ((ps.ciRetryCount ?? 0) >= maxCiRetries) return { kind: "step", step: "handoff" };
    return { kind: "step", step: "develop" };
  }
  if (lastEvent?.kind === "ci-status") {
    if (lastEvent.status === "success") return { kind: "step", step: "merged" };
    if (lastEvent.status === "failure") {
      // The re-fix loop. Cap at MAX_CI_RETRIES so a permanently-failing CI
      // (e.g., branch step ABORTed and no PR exists for CI to watch — see
      // issue #553) can't spin develop → adversarial → review → ci forever.
      // The runCi step body bumps ciRetryCount when it appends the
      // ci-status event; this check just routes on the post-bump value.
      if ((ps.ciRetryCount ?? 0) >= maxCiRetries) return { kind: "step", step: "handoff" };
      return { kind: "step", step: "develop" };
    }
    // "pending" — caller decides whether to poll again; for v1 we just stay.
    return { kind: "step", step: "ci" };
  }
  return undefined;
}
