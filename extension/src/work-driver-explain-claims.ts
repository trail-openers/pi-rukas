/**
 * work-driver-explain-claims — the operator sentences for path-claim caps:
 * a claims-lock refusal and a cross-group path conflict.
 *
 * Split from `work-driver-explain.ts` for the 500-line cap (AGENTS.md §12),
 * the same seam `work-driver-explain-other.ts` / `-lens.ts` / `-verify.ts`
 * use. Both caps explain the path-claim registry: the lock refusing a
 * registration (`work-driver-path-claims-lock.ts`) or a live sibling's claim.
 *
 * #1454 r3 — before this case existed the refusal escaped `checkAndRegisterClaims`
 * and the driver recorded `driver-crash:plan`, whose sentence says "an
 * unhandled error in the step handler". That is the wrong diagnosis by an
 * order of magnitude: the driver is fine, `.pi/work-state` is not, and an
 * operator told their driver crashed will re-run the cycle instead of fixing
 * the directory.
 */

import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * Why the claims lock refused, read off the refusal text the cap recorded.
 *
 * The two refusals carry distinct texts on purpose (a live sibling holding the
 * lock vs. a lockfile that cannot be created), and the operator's action for
 * them is opposite — wait it out versus chmod — so they are told apart here
 * rather than merged into one "the lock is busy" sentence.
 */
export function explainClaimsLock(cap: string, state: WorkState): string {
  const hit = lastCapHit(state, cap);
  const detail = (hit?.evidence ?? "").slice(0, 200);
  const cause =
    /cannot be created/.test(detail) || /writable/.test(detail)
      ? "the lockfile could not be CREATED — check that `.pi/work-state` exists and is writable by the driver's user (a read-only checkout, a root-owned `.pi`, or a full disk all look like this)"
      : "another cycle held the claims lock past the wait window — check for a leftover `.pi/work-state/path-claims.lock` whose holder pid has exited";
  return `the cycle parked at plan because the path-claim registry could not be written: ${cause}. No claim was registered and nothing was written unserialised — a claim written outside the lock is exactly the lost update that lets two workstreams edit one file, so the driver refuses rather than proceeding. The cycle's own work is intact; fix the directory or clear the stale lock and re-run /work`;
}

/** Why two cycles' declared paths collided, and when the claim is stale. */
export function explainCrossGroupConflict(state: WorkState): string {
  const hit = lastCapHit(state, "cross-group-conflict");
  const ev = hit?.evidence ?? "";
  const siblingMatch = ev.match(/claimant(\d+)/) ?? ev.match(/issue #(\d+)/);
  const siblingIssue = siblingMatch ? siblingMatch[1] : "(see evidence)";
  // #1454 — the old sentence said "active claim" and told the operator to
  // "coordinate with the other cycle's owner". In every park we measured
  // the other cycle had already exited or parked, so the advice was
  // unreachable and the re-run re-parked. A claim is honoured only while
  // its owner is alive AND its state file is non-terminal; a stale one is
  // pruned on the next read.
  return `this cycle's declared paths overlap with issue #${siblingIssue}'s path claim — two cycles cannot edit the same files in parallel. The overlapping paths are in the event log evidence field. A claim is honoured only while #${siblingIssue}'s cycle is still running: if that pid has exited, or its state file reads merged/handoff/aborted, the claim is stale and the next /work prunes it — check the pid and .pi/work-state/${siblingIssue}.json before anything else. Only when #${siblingIssue} is genuinely still running is this a real conflict; then re-plan with disjoint file sets.`;
}
