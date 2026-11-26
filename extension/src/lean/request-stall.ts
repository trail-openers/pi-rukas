/**
 * lean/request-stall — the step's wiring for the #2644 lever: pins the lean reserve into the
 * window `src/request-stall-policy.ts` derives and adds the run's clock. The policy itself —
 * switch, window, inertness line, frozen arms — lives there: spawn policy, not engine state.
 */

import { type StallArms, requestStallWindowMs } from "../request-stall-policy.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "./review-bound.ts";
import type { LeanRun } from "./state.ts";

/** The arms one step passes `armBudget`, from the run's own clock. The stream reading is a
 *  placeholder: the child's spawn replaces it with its own stamp and in-flight set. */
export function stallArms(ctx: { run: LeanRun; now: () => number }): StallArms {
  const now = ctx.now();
  return {
    windowMs: requestStallWindowMs(ctx.run.deadlineMs, now, REVIEW_DEADLINE_RESERVE_MS),
    silence: () => ({ sinceMs: 0, toolInFlight: false }),
    ...(ctx.run.deadlineMs === undefined ? {} : { deadlineMs: ctx.run.deadlineMs }),
    now,
  };
}
