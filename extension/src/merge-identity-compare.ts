/**
 * merge-identity-compare — #1533: the ONE rule that answers "does this head
 * still carry the reviewed patch identity?", shared by the merge guard's own
 * ledger check (merge-guard.ts step 7) and the /work driver's merged step.
 *
 * The rule was written once, in the guard, as two adjacent `if`s over
 * `latestEntry(entries, branch, "adversarial")` plus `mergeIdentity`. The
 * driver's merge needed the same decision — an approval covers one commit, and
 * "the same commit" is a merge-base patch identity, not a SHA (merging main in
 * moves the head and leaves the patch identity equal). Two copies of that rule
 * is precisely the drift this project keeps removing, so the comparison lives
 * here and both callers render their own refusal text.
 *
 * Deliberately a leaf: it reads nothing itself. The caller fetches the refs and
 * computes `currentPatchId` (with `mergeIdentity`, whose own doc says the refs
 * must already be fetched), then asks this function what the ledger says about
 * it. That keeps the network behaviour with the caller that owns its timeouts.
 */

import type { LedgerEntry } from "./review-ledger.ts";
import { latestEntry } from "./review-ledger.ts";

/** Every way the identity comparison can refuse, with the facts the caller renders. */
export type IdentityVerdict =
  /** The latest adversarial row passes and its patchId equals the head's. */
  | { ok: true; patchId: string }
  /** No adversarial row for this branch at all (never reviewed here). */
  | { ok: false; cause: "no-entry"; branch: string }
  /** The latest row exists but did not pass. */
  | { ok: false; cause: "not-passed"; branch: string; entry: LedgerEntry }
  /** The latest row passes but reviews a different patch than this head. */
  | {
      ok: false;
      cause: "patch-changed";
      branch: string;
      entry: LedgerEntry;
      reviewedPatchId: string;
      currentPatchId: string;
    };

/**
 * The adversarial half of the guard's ledger rule, as a function.
 *
 * `entries` is whatever the caller read (the guard reads the per-clone ledger;
 * the driver reads the same file for the cycle's integration branch). The
 * caller distinguishes "no ledger file" from "no rows" itself — the guard's
 * fail-closed refusal names the missing git common dir, and an empty list here
 * means the same thing as no entry, so folding that case in would lose the
 * distinction the guard needs.
 */
export function compareAdversarialIdentity(
  entries: readonly LedgerEntry[],
  branch: string,
  currentPatchId: string,
): IdentityVerdict {
  const adv = latestEntry(entries as LedgerEntry[], branch, "adversarial");
  if (!adv) return { ok: false, cause: "no-entry", branch };
  if (!adv.passed) return { ok: false, cause: "not-passed", branch, entry: adv };
  if (adv.patchId !== currentPatchId) {
    return {
      ok: false,
      cause: "patch-changed",
      branch,
      entry: adv,
      reviewedPatchId: adv.patchId,
      currentPatchId,
    };
  }
  return { ok: true, patchId: adv.patchId };
}
