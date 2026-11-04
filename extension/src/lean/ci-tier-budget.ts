/**
 * lean/ci-tier-budget — the wall clock `ci`'s full verify tier may be given.
 *
 * `ci` spends up to TWO `ci` budgets in one step: the forge wait, then the full
 * tier, sequentially. The engine consults the run's whole-cycle deadline only
 * BETWEEN steps, so a tier armed after a long wait can run its full bound past
 * the host's deadline and the container dies mid-tier with no result document.
 *
 * This module is the seam that closes that gap, kept out of `ci.ts` (which is at
 * the repository's file-size cap) and beside the deadline helpers it is made of:
 * the boundary is re-checked at the moment the tier would start — the wait may
 * have consumed the whole allowance since the poll's last look — and the bound
 * is then clamped to what the deadline still leaves minus the handoff allowance,
 * because the handback is report-only and must still be startable after the tier
 * ends. A tier with no room left is the handback naming the deadline, thrown
 * before the command is spawned: a tier nobody started is not a tier that failed.
 */

import { MINUTE_MS, clampToCycleDeadline } from "./deadline.ts";
import type { HandlerCtx } from "./engine.ts";

/**
 * The full tier's wall clock, or the handback naming the cycle deadline if the
 * tier may not start at all.
 *
 * `ciMin` is the config's `ci` minutes, already resolved by `ciMinutes`; the
 * tier's bound is that number again, sequential after the wait, so waiting out
 * 18 minutes of CI does not leave the tier a minute. `depsTierTimeoutMs` is the
 * injected override, which wins when set. With no cycle deadline the tier keeps
 * that full bound — an absent deadline is never a reason to shrink a timeout.
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
