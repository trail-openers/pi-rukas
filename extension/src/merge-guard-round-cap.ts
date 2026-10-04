/**
 * merge-guard-round-cap — the #973 alignment of the #912 merge guard with
 * AGENTS.md §1's round-cap rule.
 *
 * AGENTS.md §1 says (and the /work driver implements in
 * work-driver-lens-cap.ts): a six-lens review that runs out of ROUNDS (not
 * time) with only MEDIUM/HIGH findings outstanding, an APPROVING adversarial
 * gate, and the residual findings POSTED TO THE PR carries on to CI instead
 * of parking. A CRITICAL always parks. The driver's own merge is exempt
 * from the #912 merge guard (it is an in-process exec, not a tool_call), but
 * hand-managed PRs go through the guard — and the guard's strict
 * "latest lens entry must be passed" rule is stricter than the doctrine, so
 * a capped-but-merge-worthy hand-managed PR needs a manual operator merge.
 *
 * This module is that alignment, evaluated by the guard (merge-guard.ts)
 * AFTER the adversarial check has already passed. It mirrors
 * work-driver-lens-cap.ts's constants (MAX_REVIEW_ROUNDS = 3, the
 * ISSUES_FOUND-only condition, the CRITICAL-always-refuses rule) rather than
 * introducing a second independently-tuned number, and it reuses
 * `latestEntry` from review-ledger.ts for the round count (the new `round`
 * field on the latest lens entry, per design decision 3 — the file holds at
 * most one lens row per branch, so the round lives on the entry).
 *
 * ## The conditions (all must hold for the round-cap path to allow the merge)
 *
 *   1. Escape hatch off: `PI_ENSEMBLE_LENS_ROUND_CAP_MERGE` is not `"0"`
 *      (design decision 7 — the strict latest-entry rule applies otherwise).
 *   2. The latest lens entry's verdict is ISSUES_FOUND (a REVIEW_INCOMPLETE
 *      or CRITICAL_ISSUES_FOUND entry never qualifies — same rule the
 *      driver's cap applies: only a genuine ISSUES_FOUND verdict is a
 *      "ran out of rounds, findings are small" signal).
 *   3. The latest lens entry has `hasCritical === false`. A legacy entry
 *      without the field (pre-#973) cannot satisfy this — conservative
 *      refusal (design decision 3).
 *   4. The latest lens entry's `round >= MAX_REVIEW_ROUNDS` (3). A legacy
 *      entry without `round` counts as round 1 — never enough (design
 *      decision 3; the acceptance criterion's "existing entries count as
 *      rounds but cannot satisfy 'no CRITICAL'" is covered by condition 3,
 *      which is the stricter of the two on a legacy row).
 *   5. The PR/MR carries the disclosure marker (see `lensResidualsMarker`
 *      below), posted by `dispatch_lens_review` when its verdict is
 *      ISSUES_FOUND and an open PR/MR exists (design decision 2). The
 *      marker's `patch=` must equal the guard's current `branchPatchId`
 *      (design decision 1 — the SAME id the guard already computes, against
 *      the PR's actual base branch). A stale marker (a different patch)
 *      fails condition 5 — the findings it disclosed are for an older
 *      patch, not the one about to merge.
 *
 * The guard's existing strict rule (the latest lens entry must be `passed`)
 * still applies first — the round-cap path is an ADDITIONAL path that allows
 * a merge the strict rule would refuse. `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE`
 * (the operator escape hatch for the whole guard) is unchanged and is
 * checked before this module is ever reached.
 *
 * ## Refusal naming
 *
 * Every refusal names the specific condition that failed, so the operator
 * knows exactly what is missing (re-run the review to advance the round,
 * wait for the marker post to land, re-review after a new commit, …). The
 * guard renders the refusal verbatim.
 *
 * ## Threat model (marker authorship)
 *
 * The marker check reads every comment on the PR and accepts a marker from
 * ANY author, including one embedded in a fenced code block — the marker is
 * branch + patch-anchored, and the PR's own merge must pass every other
 * guard condition anyway. The threat model is the honest-but-forgetful
 * agent (a post that failed to land), not an adversary: forge comment
 * authorship is not a capability the guard models anywhere (no condition
 * here checks the author), so modelling it here would be theatre.
 */

import { type LedgerEntry, latestEntry } from "./review-ledger.ts";
import { MAX_REVIEW_ROUNDS } from "./work-driver-context.ts";

/**
 * The escape hatch (design decision 7): `PI_ENSEMBLE_LENS_ROUND_CAP_MERGE=0`
 * disables the round-cap path only. The strict "latest lens entry must be
 * passed" rule still applies — this is not a full merge override (that is
 * `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE`, checked earlier in the guard).
 * Absent or any other value leaves the round-cap path enabled.
 */
export function roundCapMergeEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LENS_ROUND_CAP_MERGE !== "0";
}

/**
 * The stable hidden marker a residual-findings disclosure comment carries
 * (design decision 1): the branch and the `branchPatchId` the guard
 * compares against. The marker is one line, HTML-comment-wrapped so it is
 * invisible in the rendered PR comment but greppable from the raw body.
 *
 * The guard verifies EXACTLY this shape (branch + patch) — a partial match
 * (e.g. a marker for a different patch) is a failed condition 5, not a
 * pass. The branch is compared first (cheap string equality), the patch
 * second (the expensive comparison against the current `branchPatchId`).
 */
export function lensResidualsMarker(branch: string, patchId: string): string {
  return `<!-- pi-rukas:lens-residuals branch=${branch} patch=${patchId} -->`;
}

/**
 * The shape of the round-cap path's result. `allowed` is false for BOTH
 * "the conditions are not met" (a refusal naming the first failing
 * condition) and "the round-cap path does not apply" (e.g. the latest
 * entry is already passed — the guard's strict rule handles that, so this
 * path is simply not the deciding one).
 *
 * `applies` distinguishes the two: the guard consults this path only when
 * the strict rule REFUSES (the latest lens entry is not passed). When
 * `applies` is false, the guard falls back to the strict rule's refusal
 * text (which already names the missing lens pass).
 */
export interface RoundCapDecision {
  applies: boolean;
  allowed: boolean;
  /** The condition that failed, for the refusal text (only when !allowed). */
  failedCondition?: string;
}

/**
 * Evaluate the round-cap merge path for a branch whose latest lens entry is
 * NOT passed (the guard already checked the strict rule and it refused).
 *
 * `lensComments` is the list of comment bodies on the PR/MR (the guard
 * fetches them via its own exec call — `gh pr view N --json comments`,
 * design decision 5 — and passes the bodies here; the forge seam is the
 * guard's, not this module's).
 */
export function evaluateRoundCapMerge(
  entries: LedgerEntry[],
  branch: string,
  currentPatchId: string,
  lensComments: string[],
): RoundCapDecision {
  if (!roundCapMergeEnabled()) {
    return {
      applies: false,
      allowed: false,
      failedCondition:
        "PI_ENSEMBLE_LENS_ROUND_CAP_MERGE=0 — the round-cap path is disabled; the strict latest-entry rule applies",
    };
  }
  const lens = latestEntry(entries, branch, "lens");
  if (!lens || lens.passed) {
    // The strict rule already passes (or there is no entry — the guard's
    // own refusal covers that). This path is not the deciding one.
    return { applies: false, allowed: false };
  }
  // Condition 2: the verdict must be ISSUES_FOUND. A REVIEW_INCOMPLETE or
  // CRITICAL_ISSUES_FOUND entry is not a "ran out of rounds" signal — it is
  // a "the review did not complete" or "a critical finding is open" signal,
  // and neither qualifies (the driver's cap applies the same rule). A
  // legacy entry with no verdict detail (no `detail`) is also not a
  // qualifying signal: the rule cannot verify the verdict, so it is not
  // the deciding one — the guard's strict rule (the original refusal text)
  // applies instead.
  if (lens.detail === undefined) {
    return { applies: false, allowed: false };
  }
  if (lens.detail !== "ISSUES_FOUND") {
    return {
      applies: true,
      allowed: false,
      failedCondition: `the latest lens entry's verdict is ${lens.detail ?? "unknown"}, not ISSUES_FOUND — the round-cap rule applies only to a review that ran out of rounds with small findings outstanding`,
    };
  }
  // Condition 3: hasCritical must be false. A legacy entry without the
  // field cannot satisfy this (conservative refusal — design decision 3).
  if (lens.hasCritical !== false) {
    return {
      applies: true,
      allowed: false,
      failedCondition:
        "the latest lens entry does not establish that no CRITICAL finding is present (hasCritical is missing or true) — a legacy entry counts as a round but cannot satisfy the no-CRITICAL condition; re-run the review to record it",
    };
  }
  // Condition 4: the round must be >= MAX_REVIEW_ROUNDS (3). A legacy
  // entry without `round` counts as round 1 — never enough (design
  // decision 3). The constant is the driver's (work-driver-context.ts),
  // not a second independently-tuned number.
  const round = lens.round ?? 1;
  if (round < MAX_REVIEW_ROUNDS) {
    return {
      applies: true,
      allowed: false,
      failedCondition: `the latest lens entry is round ${round}, below the ${MAX_REVIEW_ROUNDS}-round cap — re-run the review (the round-cap rule mirrors work-driver-lens-cap.ts's MAX_REVIEW_ROUNDS)`,
    };
  }
  // Condition 5: the disclosure marker. The guard fetches the PR's comments
  // and passes the bodies here; the marker must be present with the
  // CURRENT branch AND the CURRENT patch (a stale marker for an older
  // patch is a failed condition — the findings it disclosed are not the
  // findings of the patch about to merge).
  const marker = lensResidualsMarker(branch, currentPatchId);
  const disclosed = lensComments.some((c) => c.includes(marker));
  if (!disclosed) {
    return {
      applies: true,
      allowed: false,
      failedCondition:
        "no disclosure marker for this branch and patch on the PR — dispatch_lens_review posts the residual findings (with the marker) when its verdict is ISSUES_FOUND and the PR is open; a failed post leaves the guard refusing (fail closed)",
    };
  }
  return { applies: true, allowed: true };
}
