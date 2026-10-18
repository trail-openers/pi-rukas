/**
 * work-driver-explain-claims — the operator sentence for a claims-lock refusal.
 *
 * Split from `work-driver-explain.ts` for the 500-line cap (AGENTS.md §12),
 * the same seam `work-driver-explain-other.ts` / `-lens.ts` / `-verify.ts`
 * use. One cap lives here because the thing it explains is one module's
 * failure: `work-driver-path-claims-lock.ts` refusing a registration.
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
