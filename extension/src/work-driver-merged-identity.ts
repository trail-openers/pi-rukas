/**
 * work-driver-merged-identity — #1533: is the head this step is about to merge
 * the head the driver's lens review covered?
 *
 * The question has two parts, and they fail for different reasons, so they are
 * two functions: the *refusals* that a cycle's own state can answer (no branch
 * name, no remote) and the *comparison* that needs the ledger, the fetched refs
 * and the two patch identities. Splitting them keeps `verifyMergeHead` a
 * readable sequence and lets each refusal be tested without a ledger on disk.
 *
 * THE REVIEWED HEAD IS THE LENS ROW's `headSha`, and nothing else (round-1
 * review of PR #1837). The first cut asked for the latest PASSING ADVERSARIAL
 * row, and the adversarial review proved that can never be satisfied by a /work
 * cycle: the driver's adversarial gate records no ledger row at all
 * (`makeLedgerWrite` in adversarial.ts writes only from the `adversarial_loop`
 * TOOL path), and a cycle routed here by the lens round-cap holds rows whose
 * `passed` is false. As built, every /work cycle would have parked. The PM
 * decision names the lens row instead — which the driver's own lens step DOES
 * write, per round, carrying the OID it reviewed — and drops the `passed`
 * re-judgement: the lens gate and the round-cap route upstream of this step
 * already decided whether this branch may merge, and a merge gate that
 * re-decides their verdict is a second authority over one question.
 *
 * The comparison is `compareReviewedHead` (merge-identity-compare.ts) so the
 * driver and the merge guard cannot drift on what "the same reviewed patch"
 * means, and the identity is computed at BOTH commits the step is asked about —
 * the REVIEWED commit the lens row names and the VERIFIED commit the merge is
 * pinned to. Measuring one of the two (the first cut measured the verified head
 * and the head the fetch had just brought in, which under the ordinary
 * reviewed-A / verified-B / fetched-B sequence are the same commit) compares a
 * commit with itself and approves whatever the review never saw.
 */

import { existsSync } from "node:fs";
import { mergeIdentity } from "./merge-guard-reads.ts";
import { compareReviewedHead } from "./merge-identity-compare.ts";
import { isFullCommitSha } from "./review-head-sha.ts";
import { identityBase, ledgerPathFor, remoteName } from "./review-ledger-path.ts";
import type { LedgerEntry } from "./review-ledger.ts";
import { latestEntry, readLedgerAt } from "./review-ledger.ts";
import { committedPatchIdentity } from "./review-patch-identity.ts";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { HeadCheck, HeadCheckRefusal } from "./work-driver-merged-head.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";

/** Per-exec timeout for the head verification's git reads (the guard's own number). */
const EXEC_TIMEOUT_MS = 30_000;

/** A refusal under construction: `reason` plus whichever SHAs the step knew. */
function refusal(
  reason: string,
  reviewedHead?: string,
  foundHead?: string,
): { ok: false; refusal: HeadCheckRefusal } {
  return {
    ok: false,
    refusal: {
      reason,
      ...(reviewedHead ? { reviewedHead } : {}),
      ...(foundHead ? { foundHead } : {}),
    },
  };
}

/**
 * The reviewed head, as the driver's lens review recorded it: the `headSha` of
 * the LATEST lens row for this branch, read through `ledgerPathFor` — the same
 * resolution the merge guard uses for its own read, override included, so the
 * driver and the guard cannot be pointed at two different files.
 *
 * `passed` is deliberately NOT consulted. The lens gate and the round-cap route
 * decided it before this step ran, and a round-capped cycle reaching the merge
 * with its findings disclosed on the PR is a cycle those gates approved:
 * refusing it here on a stored boolean would re-litigate their verdict from a
 * different place with less context.
 */
export function reviewedHeadFromEntries(
  entries: readonly LedgerEntry[],
  branch: string,
): string | undefined {
  const lens = latestEntry([...entries], branch, "lens");
  if (!lens?.headSha) return undefined;
  // A legacy or malformed row records a branch NAME in this field (the
  // pre-#1039 shape), and a name is not a commit: matching one by string
  // equality against an OID would compare a ref to a SHA and call the
  // mismatch evidence of drift. An unusable headSha is UNKNOWN — a refusal,
  // never a match.
  if (!isFullCommitSha(lens.headSha)) {
    trace(
      `work-driver: merged head check — the lens row for ${branch} records headSha "${lens.headSha.slice(0, 40)}", not a 40-char SHA — treated as no reviewed head`,
    );
    return undefined;
  }
  return lens.headSha;
}

/**
 * The ledger read and the reviewed head out of it, with every fault named.
 *
 * An empty ledger and no ledger are different faults with different remedies,
 * so the missing-path case names the read (a broken or unreadable clone) while
 * a ledger that holds no lens row is a real answer about the review.
 */
async function readReviewedHead(
  execFn: VerifyExecFn,
  repoRoot: string,
  branch: string,
  /**
   * Where to read the ledger: a plain filesystem path, read as-is.
   *
   * Production never sets it — the check resolves the clone's own ledger through
   * `ledgerPathFor`, the same resolution every writer and the merge guard use.
   * It exists so a test can say WHICH ledger its verdict came from: `ledgerPathFor`
   * honours `PI_ENSEMBLE_REVIEW_LEDGER_FILE` before it consults git, and the
   * offline verify loop exports that override for every child it runs, so a check
   * that always resolved through `ledgerPathFor` would read the harness's shared
   * ledger and answer "no lens row" for a row its own case wrote — or answer from
   * a row some other test seeded. Every refusal names the path it actually read,
   * which is what makes the parameter observable rather than decoration.
   */
  ledgerFile?: string,
): Promise<{ ok: true; headSha: string } | { ok: false; reason: string }> {
  // Which ledger to read: the caller's `ledgerFile` when it named one, and that
  // file alone; otherwise the clone's own ledger through `ledgerPathFor` — one
  // ledger per clone, shared by its worktrees, where the lens writer recorded its
  // row. Quietly preferring another file would let the check decide for itself
  // which review this merge is verified against.
  const ledgerPath = ledgerFile === undefined ? await ledgerPathFor(execFn, repoRoot) : ledgerFile;
  if (!ledgerPath) {
    return {
      ok: false,
      reason:
        "no review ledger could be located — the reviewed head cannot be read, so nothing licenses this merge",
    };
  }
  // The file's absence is a refusal, not "no rows". `readLedgerAt` is the
  // ledger's permissive read and swallows ENOENT to an empty list, which is the
  // right contract for a caller asking "what did the review record" and the
  // wrong one here: "this clone has no ledger at all" and "the ledger holds no
  // lens row" are different faults with different remedies (a broken or
  // redirected repository versus a cycle that was never reviewed), and the
  // operator reading the park needs to know which one they are looking at.
  if (!existsSync(ledgerPath)) {
    return {
      ok: false,
      reason: `no review ledger at ${ledgerPath} — the reviewed head cannot be read, so nothing licenses this merge`,
    };
  }
  // `readLedgerAt` never throws today (every fs and parse fault is swallowed to
  // "no rows"); the guard keeps a torn file a refusal rather than a merge
  // whatever its current contract says.
  let entries: LedgerEntry[];
  try {
    entries = readLedgerAt(ledgerPath);
  } catch (err) {
    return {
      ok: false,
      reason: `the review ledger at ${ledgerPath} could not be read (${(err as Error).message?.slice(0, 120)})`,
    };
  }
  const headSha = reviewedHeadFromEntries(entries, branch);
  if (headSha === undefined) {
    return {
      ok: false,
      reason: `no lens review row with a recorded head SHA on file for \`${branch}\` in ${ledgerPath} — the /work lens step records the commit it reviewed, so a cycle with no such row was never reviewed on this branch`,
    };
  }
  return { ok: true, headSha };
}

/**
 * The state-only refusals — everything the cycle's own state can rule out
 * before a network call. Exported for the tests that assert the cheap faults
 * are cheap: a cycle with no branch name never resolves a remote.
 */
export async function headCheckRefusals(
  execFn: VerifyExecFn,
  repoRoot: string,
  branch: string | undefined,
  ledgerFile?: string,
): Promise<{ ok: true; remote: string } | { ok: false; refusal: HeadCheckRefusal }> {
  if (!branch) {
    return refusal("no branch name in pipeline state — cannot look up the reviewed head");
  }
  const remote = await remoteName(execFn, repoRoot);
  if (!remote) {
    return refusal(
      "no git remote found (origin/upstream/first) — the reviewed head cannot be checked",
    );
  }
  return { ok: true, remote };
}

/** The mismatch, in the operator's words: both SHAs and both patch ids. */
function mismatchReason(
  reviewedHead: string,
  reviewedPatchId: string,
  verifiedHead: string,
  verifiedPatchId: string,
): string {
  return `the head is not the reviewed one: the lens review covered ${reviewedHead.slice(0, 8)} (patchId ${reviewedPatchId.slice(0, 8)}) but the head to merge is ${verifiedHead.slice(0, 8)} (patchId ${verifiedPatchId.slice(0, 8)}) — content changed after the review, so the approval does not cover it; a human should look at what landed on this branch`;
}

/**
 * Fetch, read, compare. Everything after the cheap refusals: the half that
 * touches the network and the ledger, where every fault is a refusal.
 *
 * `headOid` is the verified head — the OID the CI evidence was read at, and the
 * OID the merge is pinned to whenever this function says yes. It is never
 * replaced by a fetched read: the pin is the verified OID, and if the remote
 * moved after the evidence read the forge refuses the pinned merge (the
 * `--match-head-commit` refusal is classified upstream).
 *
 * THE COMPARISON IS REVIEWED AGAINST VERIFIED, never verified against fetched.
 * The first cut measured the verified head and the head the fetch had just read
 * back, so the ordinary sequence — reviewed A, verified B, fetched B — compared B
 * with B, agreed by construction, and merged content nobody had reviewed. Both
 * patch identities are now taken over the SAME base (the merge base with the
 * mainline), which is what still forgives a branch that moved only by taking the
 * mainline in.
 */
export async function compareFetchedHead(
  execFn: VerifyExecFn,
  repoRoot: string,
  branch: string,
  headOid: string,
  remote: string,
  ledgerFile?: string,
): Promise<HeadCheck> {
  // The reviewed head first: a cycle whose lens review recorded no head has no
  // reviewed commit, and fetching a branch nobody pinned is a network call whose
  // answer cannot license a merge.
  const read = await readReviewedHead(execFn, repoRoot, branch, ledgerFile);
  if (!read.ok) return refusal(read.reason, undefined, headOid);
  const reviewedHead = read.headSha;

  // A remote is resolved BEFORE anything is believed, on both paths. Skipping it
  // when the heads agreed would let "this repository has no remote, so the
  // comparison could not be completed" pass on the strength of a row that was
  // never checked against the branch the forge actually holds — and the guard's
  // `--match-head-commit` backstop needs a remote to pin against, so it would be
  // absent for exactly that case too.
  if (!remote) {
    return refusal(
      "no git remote found (origin/upstream/first) — the reviewed head cannot be compared with what the forge holds",
      reviewedHead,
      headOid,
    );
  }

  if (reviewedHead === headOid) {
    // The common case, and the cheap one: the branch has not moved since the
    // review, so the verified head IS the reviewed head and nothing is fetched.
    return {
      ok: true,
      headOid,
      note: `the verified head ${headOid.slice(0, 8)} is the head the lens review recorded for ${branch}; the merge is pinned to it`,
    };
  }

  // The head moved, so the answer now depends on a fetch and two git reads.
  // The head moved between the review and now. That is legitimate ONLY when the
  // move was merging the mainline in — which a merge-base patch identity
  // detects — so the identity is computed at BOTH commits. A failed fetch is a
  // refusal: merging on stale refs is the exact failure this check exists for,
  // and the identity of a commit the clone does not have cannot be computed
  // without fetching first.
  const base = await identityBase(execFn, repoRoot);
  if (!base.ok) return refusal(base.reason, reviewedHead, headOid);
  const problem = netRefProblem(remote, branch, base.mainline);
  if (problem !== undefined) {
    return refusal(`git fetch refused: ${problem}`, reviewedHead, headOid);
  }
  try {
    await runNetGit(execFn, "git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      timeoutMs: EXEC_TIMEOUT_MS,
      argv: ["fetch", remote, branch, base.mainline],
    });
  } catch (err) {
    return refusal(
      `git fetch of ${remote}/${branch} failed: ${(err as Error).message?.slice(0, 160)}`,
      reviewedHead,
      headOid,
    );
  }

  // Both identities or neither: a patch identity that could not be computed at
  // one of the two commits is not evidence of equality, so it refuses rather than
  // comparing the one it has. Each side is measured over the SAME base — the
  // merge base with the mainline — which is the only way the comparison can
  // answer the question it is asked.
  //
  // `mergeIdentity` is deliberately not used here: it takes the branch NAME and
  // resolves `<remote>/<branch>` itself, so it measures the CURRENT head. Under a
  // moved head both halves then describe the same commit, their patch identities
  // agree by construction, and the check approves unreviewed content with a note
  // claiming the patch identity is unchanged. Passing the two commits the step was
  // asked about — the one the lens row names and the one the evidence names —
  // makes the two diffs of two different commits, so the verdict means what its
  // wording says.
  const reviewed = await committedPatchIdentity(
    execFn,
    repoRoot,
    reviewedHead,
    `${base.remote}/${base.mainline}`,
  );
  if (!reviewed.ok) {
    return refusal(
      `could not compute the patch identity at the reviewed head ${reviewedHead.slice(0, 8)}: ${reviewed.reason}`,
      reviewedHead,
      headOid,
    );
  }
  const verified = await committedPatchIdentity(
    execFn,
    repoRoot,
    headOid,
    `${base.remote}/${base.mainline}`,
  );
  if (!verified.ok) {
    return refusal(
      `could not compute the patch identity at the head to merge ${headOid.slice(0, 8)}: ${verified.reason}`,
      reviewedHead,
      headOid,
    );
  }

  const verdict = compareReviewedHead(reviewedHead, reviewed.patchId, verified.patchId);
  if (!verdict.ok) {
    return refusal(
      mismatchReason(reviewedHead, reviewed.patchId, headOid, verified.patchId),
      reviewedHead,
      headOid,
    );
  }
  // The head moved only by taking the mainline in, so the verified commit is the
  // reviewed content and the pin stays where the evidence put it.
  return {
    ok: true,
    headOid,
    note: `the head moved ${reviewedHead.slice(0, 8)} → ${headOid.slice(0, 8)} since the lens review and its patch identity is unchanged (the mainline merged in); the merge is pinned to ${headOid.slice(0, 8)}`,
  };
}
