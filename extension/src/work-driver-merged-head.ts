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
 *     and the pin describe one moment. Missing or malformed → no merge.
 *  2. **The reviewed identity** — for a single-workstream cycle, the head is
 *     fetched (bounded network git) and its merge-base patch identity is
 *     compared with the latest passing adversarial ledger row for the cycle's
 *     branch, with the rule the merge guard applies to agent-run merges
 *     (`compareAdversarialIdentity`). Equal — including a head that moved only
 *     by merging the mainline in, which is exactly what patch identity is for —
 *     merge. Different, no passing row, an unreadable ledger, or a failed fetch
 *     → no merge.
 *
 * Grouped cycles (more than one workstream) skip check 2: their adversarial
 * rows are recorded per workstream tree, not under the integration branch, so a
 * per-branch lookup would park every grouped cycle with a confusing reason. The
 * pin still applies, and the merge notes say the identity check did not apply.
 *
 * Per the PM decisions there is NO re-review route: a head whose changes were
 * not reviewed is never merged, and a human should look at a push that landed
 * on a driver-owned branch after review. No new cap, counter or setting.
 *
 * The second check's mechanics live in `work-driver-merged-identity.ts`; this
 * file owns the entry point and the first check, so the two refusals stay
 * separately testable — an unreadable OID and a stale identity are different
 * faults with different remedies.
 */

import type { VerifyExecFn } from "./work-driver-git.ts";
import type { MergeEvidence } from "./work-driver-merge-authority.ts";
import { compareFetchedHead, headCheckRefusals } from "./work-driver-merged-identity.ts";

/** Why the merged step will not merge, in the operator's words. */
export interface HeadCheckRefusal {
  /** Names the failed read or the mismatch; lands in `mergeHold.headCheckReason`. */
  reason: string;
  /** The OID the step reviewed, when it had one (the park names both SHAs). */
  reviewedHead?: string;
  /** The head found at merge time, when a fetch answered (the other SHA). */
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
 * say so before the command is built.
 */
export function verifiedHeadFromEvidence(evidence: MergeEvidence): HeadCheck {
  const oid = evidence.headOid;
  if (typeof oid !== "string" || oid === "") {
    return refused(
      evidence.headOidError ??
        "the merge-evidence read returned no head OID, so there is no commit to pin the merge to",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(oid)) {
    return refused(
      `the head OID the merge evidence reported is not a full 40-char SHA (${oid.slice(0, 48)})`,
    );
  }
  return { ok: true, headOid: oid, note: "" };
}

/**
 * The merged step's whole head verification, in sequence: the verified OID from
 * the evidence, then the reviewed identity for a single-workstream cycle.
 *
 * `workstreamCount` > 1 skips the identity comparison and says so in the
 * returned note; the pin is unaffected. `branch` is the cycle's integration
 * branch name, the same string the ledger rows record.
 *
 * The identity comparison runs only when the CALLER asked for it — which is
 * when it has somewhere to look. A caller with no repoRoot it can read a
 * ledger from, or no branch name to look a row up by, gets the pin and an
 * honest note instead: those inputs are absent in a resumed or hand-built
 * state file, and parkingsuch a cycle on "no git remote found" would be the
 * driver inventing a fault the cycle never had. A real cycle always has both.
 */
export async function verifyMergeHead(
  execFn: VerifyExecFn,
  repoRoot: string,
  branch: string | undefined,
  evidence: MergeEvidence,
  workstreamCount: number,
  opts: { identityCheck?: boolean } = {},
): Promise<HeadCheck> {
  const head = verifiedHeadFromEvidence(evidence);
  if (!head.ok) return head;

  if (opts.identityCheck === false || !branch || !repoRoot) {
    return {
      ok: true,
      headOid: head.headOid,
      note: "the merge is pinned to the verified head; the reviewed-identity comparison did not run (no branch name or repository to read the review ledger from)",
    };
  }

  const cheap = await headCheckRefusals(execFn, repoRoot, branch, workstreamCount);
  if (!cheap.ok) return cheap;
  if (cheap.grouped) {
    return {
      ok: true,
      headOid: head.headOid,
      note: `grouped cycle (${workstreamCount} workstreams): the merge is pinned to the verified head, but the reviewed-identity comparison did not apply — adversarial rows for a grouped cycle are recorded per workstream, not under the integration branch`,
    };
  }
  return compareFetchedHead(
    execFn,
    repoRoot,
    branch as string,
    head.headOid,
    cheap.remote,
    cheap.mainline,
  );
}
