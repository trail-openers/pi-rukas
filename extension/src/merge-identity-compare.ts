/**
 * merge-identity-compare — #1533: the rules that answer "does this head still
 * carry the reviewed patch identity?", shared by the merge guard's own ledger
 * check (merge-guard.ts step 7) and the /work driver's merged step.
 *
 * The adversarial rule was written once, in the guard, as two adjacent `if`s
 * over `latestEntry(entries, branch, "adversarial")` plus `mergeIdentity`. The
 * driver's merge needed the same decision — an approval covers one commit, and
 * "the same commit" is a merge-base patch identity, not a SHA (merging main in
 * moves the head and leaves the patch identity equal). Two copies of that rule
 * is precisely the drift this project keeps removing, so the comparisons live
 * here and both callers render their own refusal text.
 *
 * Deliberately a leaf: it reads nothing itself. The caller fetches the refs and
 * computes the patch ids (with `mergeIdentity` / `committedPatchIdentity`,
 * whose own docs say the refs must already be fetched), then asks this module
 * what the ledger or the two commits say. That keeps the network behaviour with
 * the caller that owns its timeouts.
 *
 * TWO rules, because the two callers ask two questions:
 *
 *  - `compareAdversarialIdentity` — the guard's: the latest adversarial row
 *    must be `passed` AND carry this head's patch id.
 *  - `compareReviewedHead` — the driver's (#1533 round-1 decision): the driver's
 *    own lens step recorded the OID it reviewed, so there is no stored boolean
 *    to trust and none to re-judge — the question is whether the head's patch
 *    identity SURVIVED the move from that OID. A lens row's `passed` is decided
 *    upstream by the lens gate and the round-cap route, and re-deciding it at
 *    the merge would put a second authority over one verdict.
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

/** What `compareReviewedHead` can say about two commits. */
export type ReviewedHeadVerdict =
  /** Same patch identity at both commits: the head moved only by taking main in. */
  | { ok: true }
  /** The patch identity differs: the branch changed content after the review. */
  | { ok: false; cause: "patch-changed" };

/**
 * The driver's rule (#1533, round-1 decision): given the OID the cycle's lens
 * review recorded, does the head still carry the reviewed patch identity?
 *
 * The caller supplies BOTH patch ids because it owns the network half: it
 * fetches the refs and computes the identity at the reviewed/verified commit
 * and at the commit the branch actually points at. Equal ids mean the only move
 * was merging the mainline in — the case patch identity exists to forgive, and
 * the reason a SHA comparison would have parked every cycle whose base moved.
 *
 * Pure, and deliberately so: no ledger, no git, no branch-name lookup, so the
 * rule is testable without either caller's machinery.
 */
export function compareReviewedHead(
  _reviewedHead: string,
  reviewedPatchId: string,
  currentPatchId: string,
): ReviewedHeadVerdict {
  // `_reviewedHead` is part of the signature for the same reason the guard's
  // version names its branch: the refusal the caller renders quotes the OID, and
  // a rule that took only the two ids could be handed a pair that has nothing to
  // do with the commit it claims to describe. The caller resolved it from the
  // lens row and passes it through unchanged.
  return reviewedPatchId === currentPatchId ? { ok: true } : { ok: false, cause: "patch-changed" };
}
