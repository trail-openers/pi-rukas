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
 * AFTER the adversarial check has already passed. Its entry point is
 * `evaluateRoundCapMerge`; the full rule (the conditions, the refusal
 * naming, the escape hatch) lives in AGENTS.md §1 and in
 * work-driver-lens-cap.ts's own routing — this module mirrors those
 * constants rather than introducing a second independently-tuned number.
 * Marker threat model: the marker check accepts a marker from ANY comment
 * author — the marker is branch + patch-anchored, and the PR's own merge
 * must pass every other guard condition anyway (the threat model is the
 * honest-but-forgetful agent, not an adversary).
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
 *
 * `prHeadOid` is the PR's CURRENT head commit — the value the guard already
 * fetched and checked against the PR's `headOid` (a mismatch there is an
 * earlier, stricter refusal in the guard, so reaching this function means
 * the fetched head IS the PR head). Condition 6 requires the latest lens
 * entry's `headSha` to equal it (see the module header).
 */
export function evaluateRoundCapMerge(
  entries: LedgerEntry[],
  branch: string,
  currentPatchId: string,
  lensComments: string[],
  prHeadOid: string,
): RoundCapDecision {
  if (!roundCapMergeEnabled()) {
    return {
      applies: false,
      allowed: false,
      failedCondition:
        "PI_ENSEMBLE_LENS_ROUND_CAP_MERGE=0 — the round-cap path is disabled (set PI_ENSEMBLE_LENS_ROUND_CAP_MERGE=1 or unset it to re-enable); the strict latest-entry rule applies",
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
  // and neither qualifies (the driver's cap applies the same rule). A legacy
  // row with NO `detail` field is not a qualifying signal either — the rule
  // cannot verify the verdict, so this path is not the deciding one and the
  // guard's strict rule (the original refusal text) applies instead. A
  // MALFORMED row (a non-string `detail` that slipped past the loader) is
  // still a refusal naming the verdict condition, not a silent "not
  // applicable" — the rule cannot verify it either way, and a corrupted row
  // must not be waved through. (typeof guard, no cast: a malformed row must
  // refuse, never throw.)
  const detail = typeof lens.detail === "string" ? lens.detail : undefined;
  if (detail === undefined) {
    if (lens.detail === undefined) return { applies: false, allowed: false };
    return {
      applies: true,
      allowed: false,
      failedCondition:
        "the latest lens entry's verdict is malformed (not a string) — the round-cap rule cannot verify the verdict, so the merge is refused; re-run the review to record a verdict",
    };
  }
  if (detail !== "ISSUES_FOUND") {
    return {
      applies: true,
      allowed: false,
      failedCondition: `the latest lens entry's verdict is ${detail}, not ISSUES_FOUND — the round-cap rule applies only to a review that ran out of rounds with small findings outstanding`,
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
  // Condition 6: the lens entry must be tied to the PR's CURRENT head
  // commit. A review of an older commit cannot satisfy the cap — the
  // commits after it are unreviewed by the lens. A legacy entry without
  // `headSha` cannot satisfy it either (conservative refusal, the same
  // rule condition 3 applies to `hasCritical`). A malformed row (a
  // non-string `headSha`) is treated as ABSENT the same way — it must
  // refuse, never throw (typeof guard, no .slice on a non-string).
  const headSha = typeof lens.headSha === "string" ? lens.headSha : undefined;
  if (headSha === undefined) {
    return {
      applies: true,
      allowed: false,
      failedCondition:
        "the latest lens entry has no headSha (legacy entry) — the round-cap rule cannot verify the review covered the PR's current head; re-run the review to record it",
    };
  }
  if (headSha !== prHeadOid) {
    return {
      applies: true,
      allowed: false,
      failedCondition: `the latest lens entry reviewed ${headSha.slice(0, 8)}, not the PR's current head ${prHeadOid.slice(0, 8)} — the branch moved after the review; re-run dispatch_lens_review on the current head`,
    };
  }
  return { applies: true, allowed: true };
}
