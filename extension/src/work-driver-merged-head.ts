/**
 * work-driver-merged-head — #1533: the merged step's head verification.
 *
 * An approval covers ONE commit. Until now the driver's merge asked the forge
 * to merge "this PR" and the forge merged whatever head it held when the
 * command ran, so a push landing between the review and the merge was merged
 * unreviewed. The merge guard says of its own head check: *"It is NOT atomic
 * with the merge — a concurrent push between the check and the merge is not
 * detectable here."* The driver's merge is now atomic on head: the OID the
 * merged step verified is the OID the forge is told to match
 * (`--match-head-commit` / `--sha`), and the merge is refused unless the two
 * agree.
 *
 * Two checks, both failing closed to the existing `awaiting-human-merge` park:
 *
 *  1. **The verified head** — the full 40-char OID from the SAME bounded read
 *     that supplied the CI evidence (`gatherMergeEvidence`), so the CI verdict
 *     and the pin describe one moment. `undefined` — the read did not answer,
 *     failed, or answered with something that is not an OID — is no merge. The
 *     type is `string | undefined` and the narrowing is a type guard, not a
 *     cast: a merge command built from a value this file could not vouch for is
 *     the failure the whole check exists to prevent (both round-1 lens HIGHs
 *     were about a cast that papered over exactly this).
 *  2. **The reviewed head** — the `headSha` of the latest LENS ledger row for
 *     the cycle's branch, read through the same resolution the merge guard uses
 *     for its own read. Equal to the verified head → merge, pinned to it.
 *     Different → both refs are fetched with the bounded network-git helper and
 *     the merge-base patch identity is computed at BOTH commits; equal (the head
 *     moved only by merging the mainline in) → merge pinned to the fetched OID;
 *     different, no lens row, an unreadable ledger, a failed fetch or a failed
 *     identity read → no merge, and the park names both SHAs.
 *
 * WHY the lens row and not the adversarial one (round-1 review of PR #1837):
 * the driver's adversarial gate writes NO ledger row — `makeLedgerWrite` records
 * only the `adversarial_loop` TOOL path — and a round-capped cycle's rows are
 * `passed: false`, so an adversarial-row rule parked every /work cycle. The
 * lens step is the review the driver itself runs on the integrated branch, and
 * it records the OID it covered on every round. Grouped cycles take the same
 * rule: the lens review covers the one integrated branch the merge merges, so
 * there is nothing to skip and no `workstreamCount` to consult.
 *
 * Per the PM decisions there is NO re-review route: a head whose changes were
 * not reviewed is never merged, and a human should look at a push that landed on
 * a driver-owned branch after review. No new cap, counter or setting.
 *
 * The second check's mechanics live in `work-driver-merged-identity.ts`; this
 * file owns the entry point and the first check, so the two refusals stay
 * separately testable — an unreadable OID and a stale head are different faults
 * with different remedies.
 */

import { isFullCommitSha } from "./review-head-sha.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { MergeEvidence } from "./work-driver-merge-authority.ts";
import {
  compareFetchedHead,
  headCheckRefusals,
  reviewedHeadFromEntries,
} from "./work-driver-merged-identity.ts";

/** Why the merged step will not merge, in the operator's words. */
export interface HeadCheckRefusal {
  /** Names the failed read or the mismatch; lands in `mergeHold.headCheckReason`. */
  reason: string;
  /** The OID the step reviewed, when it had one (the park names both SHAs). */
  reviewedHead?: string;
  /** The head found at merge time, when a read answered (the other SHA). */
  foundHead?: string;
}

export type HeadCheck =
  | {
      ok: true;
      /** The OID to pin the merge to. */
      headOid: string;
      /** Merged into the operator-facing notes: what the check did and did not cover. */
      note: string;
    }
  | { ok: false; refusal: HeadCheckRefusal };

/** A refusal under construction, with the SHAs the step knew at that point. */
function refused(reason: string, reviewedHead?: string): HeadCheck {
  return { ok: false, refusal: { reason, ...(reviewedHead ? { reviewedHead } : {}) } };
}

/**
 * Check 1 — the verified head the CI evidence was read at.
 *
 * The shape is re-checked here rather than trusted from the read: the pin's
 * whole claim is precision about one commit, and this is the last place that can
 * say so before the command is built. `MergeEvidence.headOid` is
 * `string | undefined` — deliberately not `""`, which is neither a value nor an
 * absence and forces every consumer to guess — so narrowing happens through
 * this guard and no caller of the result ever casts.
 */
export function verifiedHeadFromEvidence(evidence: MergeEvidence): HeadCheck {
  const oid: string | undefined = evidence.headOid;
  if (oid === undefined || oid === "") {
    return refused(
      evidence.headOidError ??
        "the merge-evidence read returned no head OID, so there is no commit to pin the merge to",
    );
  }
  if (!isFullCommitSha(oid)) {
    return refused(
      `the head OID the merge evidence reported is not a full 40-char SHA (${oid.slice(0, 48)})`,
    );
  }
  return { ok: true, headOid: oid, note: "" };
}

/**
 * The merged step's whole head verification, in sequence: the verified OID from
 * the evidence, then that OID against the head the cycle's lens review recorded.
 *
 * `branch` is the cycle's integration branch name — the same string the lens
 * writer keys its row on — and the comparison is attempted whenever the caller
 * has a branch name to look a row up by. A caller with no branch name gets the
 * pin and an honest note instead: that input is absent in a resumed or
 * hand-built state file, and parking such a cycle on "no lens row on file"
 * would be the driver inventing a fault the cycle never had. A real cycle always
 * has one, and gets the full rule.
 */
export interface VerifyMergeHeadOpts {
  /**
   * The ledger the reviewed head is read from. Production never sets it: the
   * check resolves the clone's own ledger through `ledgerPathFor`, the same
   * resolution every writer uses, and a caller that hardcoded a path could read
   * a file the review never wrote. A test must be able to say WHICH ledger its
   * verdict came from, though — `ledgerPathFor` honours
   * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` before any git call, and the offline verify
   * loop documents that override as the isolation every ledger-writing test
   * uses, so without this a scenario can be answered out of another test's file
   * and report "no lens row" for a row that is genuinely on disk.
   */
  ledgerFile?: string;
  /**
   * Pin without comparing, for a caller that has no repository to read a ledger
   * from. The note then says the comparison did not run, so the pass is honest.
   */
  skipIdentity?: boolean;
}

export async function verifyMergeHead(
  execFn: VerifyExecFn,
  repoRoot: string,
  branch: string | undefined,
  evidence: MergeEvidence,
  opts: VerifyMergeHeadOpts = {},
): Promise<HeadCheck> {
  const head = verifiedHeadFromEvidence(evidence);
  if (!head.ok) return head;

  if (opts.skipIdentity === true || !branch || !repoRoot) {
    return {
      ok: true,
      headOid: head.headOid,
      note: "the merge is pinned to the verified head; the reviewed-head comparison did not run (no branch name or repository to read the review ledger from)",
    };
  }

  const cheap = await headCheckRefusals(execFn, repoRoot, branch);
  if (!cheap.ok) return cheap;
  return compareFetchedHead(execFn, repoRoot, branch, head.headOid, cheap.remote, opts.ledgerFile);
}
