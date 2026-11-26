/**
 * lean/child-opts — the permission stamp a lean run's children carry.
 *
 * The lean engine dispatches through `spawnSpecialist` directly rather than through a driver cycle, so its
 * children do not pass `cycleDispatch(ctx)`. In an interactive session that is fine. Headless it is not: there
 * is no UI, so a child without a stamp lands on the headless path that hard-denies any `ask`-class verdict,
 * and every lean child dies.
 *
 * The answer is the same stamp the headless /work driver's children carry, decided by the same function —
 * `cycleChildOpts`. `leanChildOpts` is the lean run's call site of it, and the flag is **threaded, never
 * remembered**, so a second lean run in one process cannot inherit the first run's trust.
 * `PI_ENSEMBLE_STRICT_PERMISSIONS=1` is honoured by `workCycleTrustEnabled()`, which refuses the stamp.
 */

import { cycleChildOpts } from "../work-cycle-trust.ts";

// Spread AFTER the caller's own options at the dispatch site, so no caller can opt a child out of the
// stamp. `headless` is a REQUIRED argument so a dispatch site that drops its run's mode is a compile error.
export function leanChildOpts(headless: boolean): { workCycleTrust: boolean } {
  return cycleChildOpts({ headless });
}
