/**
 * work-driver-judge-seam — who is allowed to answer the merge-authority judge.
 *
 * The merge-authority gate asks a policy judge one yes/no question (#407). The
 * answer normally comes from a spawned judge child, but `DriverContext` also
 * carries `policyJudgeFn`, an injected function that answers instead — which is
 * how the offline suite drives the gate without a fork. That seam is reachable
 * from outside the driver: the headless runner forwards `policyJudgeFn` through
 * `driverSeams` (`headless/run.ts`), so a caller of the exported `runHeadless` —
 * not only a unit test holding a `DriverContext` — can put an ANSWER in front of
 * the gate.
 *
 * The answer is normally still citation-verified by `decide()` against the
 * doctrine read at the cycle's base commit, so an injected voice cannot simply
 * assert permission. But the seam is the one place a caller can hand the gate a
 * verdict-shaping voice at all, so the voice is honoured only where the harness
 * that needs it actually runs: the offline suite sets
 * `PI_ENSEMBLE_FORBID_LIVE_SPAWN=1` (a live spawn is refused outright there, so
 * the real judge could not answer anyway). Everywhere else — including a host
 * that simply did not set the variable — the step builds the real `judgePolicy`
 * child and the injected function is ignored, with a warning on the trace so a
 * cycle that expected its seam to speak can see that it did not (#1025).
 *
 * Split out of `work-driver-merge-authority.ts`, which the file-size cap
 * (AGENTS.md §12) would not otherwise leave room for.
 */

import { traceWarn } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import type { PolicyJudgeFn } from "./work-driver-policy.ts";

/**
 * Whether an injected policy judge may speak for this process (#1025). See the
 * module header for why the offline suite's own setting is the gate.
 */
function injectedJudgeAllowed(): boolean {
  return process.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN === "1";
}

/**
 * The judge this cycle asks: the injected one when the offline harness is
 * running, the real spawn-side judge everywhere else. Exported so the
 * host-inertness contract has a named seam a test can drive without a fork.
 */
export function mergeAuthorityJudge(ctx: CycleContext, build: () => PolicyJudgeFn): PolicyJudgeFn {
  const injected = ctx.policyJudgeFn;
  if (!injected) return build();
  if (!injectedJudgeAllowed()) {
    traceWarn(
      "work-driver: an injected policy judge was ignored — the merge-authority " +
        "judge seam is test-only and this process does not set " +
        "PI_ENSEMBLE_FORBID_LIVE_SPAWN=1; the real doctrine judge was used",
    );
    return build();
  }
  traceWarn(
    "work-driver: merge authority is being judged by an INJECTED judge " +
      "(PI_ENSEMBLE_FORBID_LIVE_SPAWN=1) — this is a test harness, not a live cycle",
  );
  return injected;
}
