/**
 * lean/child-opts — the permission stamp a lean run's children carry (#1883).
 *
 * The lean engine dispatches through `spawnSpecialist` directly rather than
 * through a driver cycle, so its children do not pass `cycleDispatch(ctx)`. In
 * an interactive session that is fine — the parent is already in trust mode and
 * `spawn-permission.ts` trusts the child on that fact alone. Headless it is
 * not: there is no UI, so a child without a stamp lands on the headless path
 * that hard-denies any `ask`-class verdict, and every lean child dies.
 *
 * The answer is the same stamp the headless /work driver's children carry
 * (#1666), decided by the same function — `cycleChildOpts`, which reads a
 * `headless` flag and nothing else. `leanChildOpts` is the lean run's call site
 * of it. The headless CLI marks this process before the engine runs and nothing
 * else does: an interactive `/work-lean` in a Pi session never calls
 * `markLeanHeadless`, so its children stay unstamped exactly as they were
 * before, and an inherited marker in a caller's environment cannot make an
 * interactive run claim a trust it did not get.
 *
 * `PI_ENSEMBLE_STRICT_PERMISSIONS=1` is honoured by the same predicate the
 * driver honours it through: `workCycleTrustEnabled()` in
 * `spawn-permission.ts` refuses the stamp when the operator opted into strict,
 * so a strict run's children are still bounded by the allowlist.
 */

import { cycleChildOpts } from "../work-cycle-trust.ts";

/**
 * Set once, by the headless `work-lean` verb, before the engine runs. Only the
 * verb calls it — not an env var, so a caller cannot make an interactive
 * `/work-lean` claim the trust stamp a headless run gets.
 */
let headlessProcess = false;

/** Mark this process as a headless lean run. Verb-only; not a caller knob. */
export function markLeanHeadless(): void {
  headlessProcess = true;
}

/** Read once at dispatch time; a test may observe it, nothing else sets it. */
export function isLeanHeadless(): boolean {
  return headlessProcess;
}

/**
 * The spawn options every lean dispatch adds. Spread AFTER the caller's own
 * options at the dispatch site, so no caller can opt a child out of the stamp
 * — the same rule `cycleDispatch` applies to a driver cycle's children.
 */
export function leanChildOpts(
  ctx: { readonly headless?: boolean } = { headless: headlessProcess },
): { workCycleTrust: boolean } {
  return cycleChildOpts(ctx);
}
