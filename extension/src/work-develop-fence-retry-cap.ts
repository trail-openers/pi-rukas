/**
 * #1427 fix round — the cap the fence merge-and-retry parks with when the
 * re-run's VERIFY gate fails.
 *
 * #1005's acceptance criterion ("a second failure after merging hands off, and
 * the handoff names the merge") holds whichever way the cap is spelled, but the
 * cap itself is the diagnosis the operator reads:
 *
 *   - every failure is one the wall clock KILLED → the run reached no verdict,
 *     so `verifyCapFor` gives `verify-timeout:develop`. Reporting a fence
 *     problem there sends the operator to restore a scope boundary when the
 *     gate simply ran out of time (the round-1 defect);
 *   - anything else — a genuine verify verdict, or a blocking fence record from
 *     the re-run — keeps `fence-violation:develop`, the cap this path has
 *     carried since #849/#1005 (test-fence-recovery-849-edges.ts case 2 pins
 *     that half).
 *
 * Split into its own module so the retry flow stays under AGENTS.md §12's cap
 * and the rule is testable without a git fixture.
 */
import { FENCE_VIOLATION_CAP } from "./work-develop-fence-recovery.ts";
import { isVerifyTimeoutFailure, verifyCapFor } from "./work-driver-verify-develop-helpers.ts";
import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";

/**
 * @param blockingFenceSecond the re-run's blocking fence records exist
 *   (a `sibling-declared` / `issue-fenced` violation survived the merge).
 * @param reRunOk the re-run's verify gate passed.
 * @param failures the re-run gate's failure strings.
 */
export function mergeRetryCap(
  blockingFenceSecond: boolean,
  reRunOk: boolean,
  failures: readonly string[],
): WorkCapLiteral {
  // A clean verify re-run that still carries a blocking fence record is a
  // decomposition problem. A re-run whose every failure is a timeout reached no
  // verdict at all, so it is the timeout the operator can act on. Everything
  // else — a real verify failure beside or instead of a fence record — keeps
  // the fence cap, because that is the concern that triggered this path.
  if ((reRunOk && blockingFenceSecond) || !failures.every(isVerifyTimeoutFailure))
    return FENCE_VIOLATION_CAP;
  return verifyCapFor("develop", failures);
}
