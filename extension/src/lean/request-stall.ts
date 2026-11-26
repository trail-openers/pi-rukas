/**
 * lean/request-stall — the step's wiring for the #2644 lever. The policy (switch, window,
 * inertness line, frozen arms) lives in `src/request-stall-policy.ts`: spawn policy, not engine
 * state. This leaf keeps the lean import site and supplies the reserve and the run's clock.
 */

export {
  leanRequestStallEnabled,
  requestStallUnarmed,
  requestStallWindowMs as requestStallWindowMsFromPolicy,
} from "../request-stall-policy.ts";
import { requestStallWindowMs as policyWindowMs, type StreamSilence } from "../request-stall-policy.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "./review-bound.ts";
import type { LeanRun } from "./state.ts";
import type { StallArms } from "./step-budget.ts";

/** The silence a model request may sit out, ms; `undefined` = inert, never a zero window. */
export function requestStallWindowMs(
  deadlineMs: number | undefined,
  now: number,
): number | undefined {
  return policyWindowMs(deadlineMs, now, REVIEW_DEADLINE_RESERVE_MS);
}

/** The arms one step passes `armBudget`, from the run's own clock. A step has no stream to
 *  read — the child's spawn supplies its stamp and hands the breach back through the arm's
 *  `onProgress` — so the reader here measures nothing. */
export function stallArms(ctx: { run: LeanRun; now: () => number }): StallArms {
  const now = ctx.now();
  const silence: StreamSilence = () => ({ sinceMs: 0, toolInFlight: false });
  return {
    windowMs: requestStallWindowMs(ctx.run.deadlineMs, now),
    silence,
    ...(ctx.run.deadlineMs === undefined ? {} : { deadlineMs: ctx.run.deadlineMs }),
    now,
  };
}
