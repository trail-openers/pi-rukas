/**
 * lean/ci-tier-budget — the wall clock `ci`'s full verify tier may be given.
 *
 * `ci` spends up to TWO `ci` budgets in one step — the forge wait, then the full tier,
 * sequentially — and the engine consults the run's whole-cycle deadline only BETWEEN
 * steps, so a tier armed after a long wait can run past the host's deadline and die
 * mid-tier with no result document.
 *
 * The boundary is therefore re-checked at the moment the tier would start, and the bound
 * clamped to what the deadline leaves minus the handoff allowance, which is report-only
 * and must stay startable. A tier with no room left is the handback naming the deadline,
 * thrown before the command spawns: a tier nobody started is not a tier that failed.
 */
import { MINUTE_MS, clampToCycleDeadline } from "./deadline.ts";
import type { HandlerCtx } from "./engine.ts";

/**
 * The full tier's wall clock, or the handback naming the cycle deadline if the
 * tier may not start at all.
 *
 * The tier's bound is the config's `ci` minutes again — sequential after the
 * wait — with `depsTierTimeoutMs` winning when set. With no cycle deadline the
 * tier keeps that full bound: an absent deadline never shrinks a timeout.
 */
export function ciTierBudgetMs(
  ctx: HandlerCtx,
  depsTierTimeoutMs: number | undefined,
  ciMin: number,
): number {
  return clampToCycleDeadline(
    ctx.run.deadlineMs,
    ctx.now(),
    depsTierTimeoutMs ?? ciMin * MINUTE_MS,
    "ci full tier",
  );
}
