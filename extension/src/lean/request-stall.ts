/**
 * lean/request-stall — the step's wiring for the #2644 lever: the reserve the window is capped by,
 * the run's deadline it is measured against, and the child's stream reader. The policy itself —
 * switch, window, inertness line, frozen arms — lives in `src/request-stall-policy.ts`: spawn
 * policy, not engine state.
 */
import type { StallArms } from "../request-stall-policy.ts";
import type { HandlerCtx } from "./engine.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "./review-bound.ts";

/** The arms one step passes `armBudget`. It reads **no clock**: `stepBound` already measures the
 *  step's spend from the start the durable record holds (the newest entry for this step's state), so
 *  the lever reads that same entry rather than calling `ctx.now()` — a scripted clock
 *  (`test-lean-review-bound-record.ts`) counts reads and would shift the step's stop by one slot,
 *  and two reads would let the bound, the reserve and the lever disagree about when the step began.
 *  No start on the record means no lever: an unmeasurable window is no bound. The stream reading is
 *  a placeholder: the child's spawn replaces it with its own stamp and in-flight set. */
export function stallArms(ctx: Pick<HandlerCtx, "run" | "steps" | "stepKey">): StallArms {
  const state = ctx.stepKey.split(":")[1];
  let startedAt: number | undefined;
  for (const step of ctx.steps) if (step.state === state) startedAt = step.startedAt;
  return {
    reserveMs: REVIEW_DEADLINE_RESERVE_MS,
    silence: () => ({ sinceMs: 0, toolInFlight: false }),
    ...(ctx.run.deadlineMs === undefined ? {} : { deadlineMs: ctx.run.deadlineMs }),
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}
