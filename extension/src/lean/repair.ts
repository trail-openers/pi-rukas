import { repairStepBody } from "../oracle-repair-step.ts";
import type { RepairDeps as RepairWiringDeps } from "../oracle-repair-wiring.ts";
import type { HandlerCtx } from "./engine.ts";
import type { Outcome } from "./state.ts";

/**
 * lean/repair — the `repair` handler entry. The round's body is `oracle-repair-step.ts`; this file is the line
 * the engine's handler table calls. A refusal is a `refused` kind the table routes; only git it cannot account
 * for throws.
 */
export function repairOutcome(
  ctx: HandlerCtx,
  deps: RepairWiringDeps,
  headless: boolean,
): Promise<Outcome> {
  return repairStepBody(ctx, deps, headless);
}
