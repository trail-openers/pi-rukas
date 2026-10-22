/**
 * work-driver-explain-fence — the cap-hit sentences for the develop scope
 * fence and the commit-pr integration worktree audit, split from
 * `work-driver-explain.ts` so that switch keeps the §12 500-line cap with
 * headroom for new caps. Same seam as `work-driver-explain-develop-crash.ts`
 * and friends: one cap family, one module, and the `explainCap` switch keeps a
 * one-line case for it.
 *
 * Both sentences share the thing worth keeping in one place: each names a tree
 * the driver refused to trust, and each tells the operator to inspect that tree
 * rather than re-run the dispatch that produced it.
 */

import { INTEGRATE_CREATE_FAILED_PREFIX, lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

/** `#861` — the commit-pr ops-fallback audit's "integrate branch held by the
 *  wrong tree" prefix, matched before the sentence is built. */
export function explainIntegrationWorktreeViolation(state: WorkState): string {
  // The holder path rides in the cap's evidence; the PR-verification gates were
  // refused so no PR was validated from the wrong tree (the #841 shape: #841's
  // ops child checked its branch out inside #844's worktree). The integrate
  // worktree is KEPT for inspection.
  const hit = lastCapHit(state, "integration-worktree-violation");
  const evidence = hit?.evidence ?? "(no holder recorded)";
  // #1543 — the same cap, raised before any ops child or audit existed.
  if (evidence.startsWith(INTEGRATE_CREATE_FAILED_PREFIX)) {
    return `commit-pr could not create the driver-owned integrate worktree — git said: ${evidence.slice(INTEGRATE_CREATE_FAILED_PREFIX.length)}. No ops child was dispatched and no branch-holder audit ran: the commit-pr fallback is pinned to that worktree and refused to work anywhere else. The git error is the cause — check that repoRoot is still a usable git repository (another process sharing the clone may have moved or removed it), then re-run \`/work <issue>\``;
  }
  return `commit-pr's ops fallback worked in the wrong tree: after the dispatch, the integration branch is held by a worktree that is NOT the driver-owned integrate worktree — ${evidence}. The driver's post-dispatch branch-holder audit halted the cycle BEFORE the PR-verification gates, so no PR was validated from the wrong tree (the #841 defect: #841's ops child checked its branch out inside #844's worktree). The driver-owned integrate worktree is preserved for inspection; inspect the offending holder, move the branch back, and re-run`;
}

/** `#849` — the develop scope fence's terminal park. A recovery round was
 *  attempted (the violator's commit discarded, the violator re-dispatched
 *  once); a second violation, a violator-owner cycle, or a git failure
 *  discarding the violator's commit parked the cycle. Both attempts ride in the
 *  cap's evidence (the first via the discarded SHA, the second via the re-run's
 *  fence record) — inspect them before re-planning. */
export function explainFenceViolationDevelop(state: WorkState): string {
  const hit = lastCapHit(state, "fence-violation:develop");
  const ev = hit?.evidence ?? "(no detail recorded)";
  return `the develop scope fence's recovery could not converge — a recovery round was attempted, and the cycle parked on what the evidence shows: ${ev}. Re-dispatching the violator again will not fix it: restore the fence boundary (split the plan so the violated file is declared by exactly one workstream) and re-run`;
}
