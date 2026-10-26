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
 */

import { mergeIdentity } from "./merge-guard-reads.ts";
import { compareAdversarialIdentity } from "./merge-identity-compare.ts";
import type { LedgerEntry } from "./review-ledger.ts";
import { ledgerPathFor, readLedgerAt, remoteName } from "./review-ledger.ts";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { MergeEvidence } from "./work-driver-merge-authority.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";

/** Per-exec timeout for the head verification's git reads (the guard's own number). */
const EXEC_TIMEOUT_MS = 30_000;

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

/**
 * Check 1 — the verified head the CI evidence was read at.
 *
 * Split from `verifyMergeHead` so the two refusals stay separately testable: an
 * unreadable OID and a stale identity are different faults with different
 * remedies, and a single function returning one string would blur them.
 */
export function verifiedHeadFromEvidence(evidence: MergeEvidence): HeadCheck {
  const oid = evidence.headOid;
  if (typeof oid !== "string" || oid === "") {
    return {
      ok: false,
      refusal: {
        reason:
          evidence.headOidError ??
          "the merge-evidence read returned no head OID, so there is no commit to pin the merge to",
      },
    };
  }
  // Re-checked here rather than trusted from the read: the pin's whole claim is
  // precision about one commit, and this is the last place that can say so
  // before the command is built.
  if (!/^[0-9a-f]{40}$/.test(oid)) {
    return {
      ok: false,
      refusal: {
        reason: `the head OID the merge evidence reported is not a full 40-char SHA (${oid.slice(0, 48)})`,
      },
    };
  }
  return { ok: true, headOid: oid, note: "" };
}

/**
 * Check 2 — the reviewed identity, for a single-workstream cycle.
 *
 * `workstreamCount` > 1 skips the comparison and says so in the returned note;
 * the pin is unaffected. `branch` is the cycle's integration branch name, the
 * same string the ledger rows record.
 */
export async function verifyMergeHead(
  execFn: VerifyExecFn,
  repoRoot: string,
  branch: string | undefined,
  headOid: string,
  workstreamCount: number,
): Promise<HeadCheck> {
  if (workstreamCount > 1) {
    const note = `grouped cycle (${workstreamCount} workstreams): the merge is pinned to the verified head, but the reviewed-identity comparison did not apply — adversarial rows for a grouped cycle are recorded per workstream, not under the integration branch`;
    return { ok: true, headOid, note };
  }
  if (!branch) {
    return {
      ok: false,
      refusal: {
        reason: "no branch name in pipeline state — cannot look up the reviewed identity",
        reviewedHead: headOid,
      },
    };
  }

  const remote = await remoteName(execFn, repoRoot);
  if (!remote) {
    return {
      ok: false,
      refusal: {
        reason:
          "no git remote found (origin/upstream/first) — the reviewed identity cannot be checked",
        reviewedHead: headOid,
      },
    };
  }
  const mainline = await resolveMainlineForHead(execFn, repoRoot, remote);
  if (!mainline.ok) {
    return {
      ok: false,
      refusal: { reason: mainline.reason, reviewedHead: headOid },
    };
  }

  // The refs must be current before any identity is computed: a local clone
  // that has not seen the latest push would report the OLD patch identity and
  // the step would merge a head it never fetched. Fail closed on a failed
  // fetch — a merge on stale refs is exactly the failure this check exists for.
  const problem = netRefProblem(remote, branch, mainline.mainline);
  if (problem !== undefined) {
    return {
      ok: false,
      refusal: { reason: `git fetch refused: ${problem}`, reviewedHead: headOid },
    };
  }
  try {
    await runNetGit(execFn, "git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      timeoutMs: EXEC_TIMEOUT_MS,
      argv: ["fetch", remote, branch, mainline.mainline],
    });
  } catch (err) {
    return {
      ok: false,
      refusal: {
        reason: `git fetch of ${remote}/${branch} failed: ${(err as Error).message?.slice(0, 160)}`,
        reviewedHead: headOid,
      },
    };
  }

  // The head the fetch actually brought in, recorded for the park's reason: the
  // operator has to see BOTH the reviewed OID and the one the branch is on now.
  let foundHead: string | undefined;
  try {
    const { stdout } = await execFn(`git rev-parse ${remote}/${branch}`, {
      cwd: repoRoot,
      maxBuffer: 8 * 1024,
      timeout: EXEC_TIMEOUT_MS,
    });
    const v = stdout.trim();
    if (/^[0-9a-f]{40}$/.test(v)) foundHead = v;
  } catch (err) {
    trace(
      `work-driver: merged head read failed for ${remote}/${branch}: ${(err as Error).message?.slice(0, 120)}`,
    );
  }
  if (foundHead === undefined) {
    return {
      ok: false,
      refusal: {
        reason: `could not read the fetched head ${remote}/${branch}`,
        reviewedHead: headOid,
      },
    };
  }

  const ledgerPath = await ledgerPathFor(execFn, repoRoot);
  if (!ledgerPath) {
    return {
      ok: false,
      refusal: {
        reason:
          "no git common dir found — the review ledger is unavailable, so the reviewed identity cannot be checked",
        reviewedHead: headOid,
        foundHead,
      },
    };
  }
  let entries: LedgerEntry[];
  try {
    entries = readLedgerAt(ledgerPath);
  } catch (err) {
    // `readLedgerAt` never throws today; the catch keeps a torn file a refusal
    // rather than a merge, whatever its current contract says.
    return {
      ok: false,
      refusal: {
        reason: `the review ledger could not be read (${(err as Error).message?.slice(0, 120)})`,
        reviewedHead: headOid,
        foundHead,
      },
    };
  }

  const identity = await mergeIdentity(execFn, repoRoot, branch, mainline.mainline);
  if (!identity.ok) {
    return {
      ok: false,
      refusal: {
        reason: `could not compute the patch identity of ${branch}: ${identity.reason}`,
        reviewedHead: headOid,
        foundHead,
      },
    };
  }

  const verdict = compareAdversarialIdentity(entries, branch, identity.patchId);
  if (!verdict.ok) {
    const adv = "entry" in verdict ? verdict.entry : undefined;
    const reviewed = adv?.patchId.slice(0, 8) ?? "none";
    const detail =
      verdict.cause === "patch-changed"
        ? `the reviewed patch ${verdict.reviewedPatchId.slice(0, 8)} ≠ the head's ${verdict.currentPatchId.slice(0, 8)}`
        : verdict.cause === "not-passed"
          ? `the latest adversarial row did not pass (patchId ${verdict.entry.patchId.slice(0, 8)})`
          : `no adversarial row on file for \`${branch}\``;
    return {
      ok: false,
      refusal: {
        reason: `the head was not the reviewed one: reviewed ${reviewed} — ${detail}`,
        reviewedHead: headOid,
        foundHead,
      },
    };
  }

  return {
    ok: true,
    headOid,
    note: `reviewed identity confirmed for ${branch} (patchId ${verdict.patchId.slice(0, 8)})`,
  };
}

/** The mainline the identity is taken against, named on failure. */
async function resolveMainlineForHead(
  execFn: VerifyExecFn,
  repoRoot: string,
  remote: string,
): Promise<{ ok: true; mainline: string } | { ok: false; reason: string }> {
  try {
    const { stdout } = await execFn("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: repoRoot,
      maxBuffer: 8 * 1024,
      timeout: EXEC_TIMEOUT_MS,
    });
    const v = stdout.trim();
    const prefix = `${remote}/`;
    if (v.startsWith(prefix)) {
      const name = v.slice(prefix.length);
      if (name) return { ok: true, mainline: name };
    }
    return {
      ok: false,
      reason: `refs/remotes/${remote}/HEAD resolved to \`${v.slice(0, 64)}\`, which is not \`${remote}/<mainline>\``,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `could not resolve the mainline from refs/remotes/${remote}/HEAD: ${(err as Error).message?.slice(0, 120)}`,
    };
  }
}
