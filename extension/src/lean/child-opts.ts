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
 * of it, and the flag is **threaded, never remembered**: `runWorkLean` takes
 * `headless` as an option and hands it to `phase1Handlers`, which hands it to
 * the three deps builders, which hand it here.
 *
 * There is deliberately no process-global marker. An earlier shape set a module
 * flag once from the headless verb, so a second lean run in the same process —
 * a host that drives two issues, or a test that runs the verb and then the
 * command — inherited the first run's trust. The headless verb passes
 * `{ headless: true }`; the interactive `/work-lean` command passes nothing, so
 * its children stay unstamped exactly as they were, and one run's mode cannot
 * leak into another's.
 *
 * `PI_ENSEMBLE_STRICT_PERMISSIONS=1` is honoured by the same predicate the
 * driver honours it through: `workCycleTrustEnabled()` in
 * `spawn-permission.ts` refuses the stamp when the operator opted into strict,
 * so a strict run's children are still bounded by the allowlist.
 */

import { cycleChildOpts } from "../work-cycle-trust.ts";

/**
 * The spawn options every lean dispatch adds. Spread AFTER the caller's own
 * options at the dispatch site, so no caller can opt a child out of the stamp
 * — the same rule `cycleDispatch` applies to a driver cycle's children.
 *
 * `headless` is a REQUIRED argument precisely so the thread cannot be dropped:
 * a dispatch site that forgot to carry its run's mode is a compile error rather
 * than a child that silently ran unstamped (headless: every tool call denied)
 * or stamped when it should not have been (interactive: a trust it never got).
 */
export function leanChildOpts(headless: boolean): { workCycleTrust: boolean } {
  return cycleChildOpts({ headless });
}
