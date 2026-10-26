/**
 * work-driver-merged-identity — #1533: is the head this step is about to merge
 * the head the review covered?
 *
 * The question has two parts, and they fail for different reasons, so they are
 * two functions: the *refusals* that a cycle's own state can answer (no branch
 * name, no remote, an unreadable mainline, no ledger file) and the *comparison*
 * that needs the fetched refs and the ledger rows. Splitting them keeps
 * `verifyMergeHead` a readable sequence and lets each refusal be tested without
 * a ledger on disk.
 *
 * The comparison itself is `compareAdversarialIdentity` (merge-identity-compare.ts)
 * — the same rule the merge guard applies to agent-run merges — so the driver
 * and the guard cannot drift on what "the same reviewed patch" means.
 */

import { mergeIdentity } from "./merge-guard-reads.ts";
import { compareAdversarialIdentity } from "./merge-identity-compare.ts";
import type { LedgerEntry } from "./review-ledger.ts";
import { ledgerPathFor, remoteName } from "./review-ledger.ts";
import { readLedgerAt } from "./review-ledger.ts";
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
 * The state-only refusals — everything the cycle's own pipeline state can rule
 * out before a single git call is made. Exported for the tests that assert the
 * cheap faults are cheap: a grouped cycle never fetches, a cycle with no branch
 * name never resolves a remote.
 */
export async function headCheckRefusals(
  execFn: VerifyExecFn,
  repoRoot: string,
  branch: string | undefined,
  workstreamCount: number,
): Promise<
  | { ok: true; grouped: false; remote: string; mainline: string }
  | { ok: true; grouped: true }
  | { ok: false; refusal: HeadCheckRefusal }
> {
  // Grouped cycles record their adversarial rows per workstream tree, not under
  // the integration branch, so a per-branch lookup would park every grouped
  // cycle with a confusing reason. The pin still applies; the caller says in the
  // merged notes that the identity comparison did not apply.
  if (workstreamCount > 1) return { ok: true, grouped: true };
  if (!branch) {
    return refusal("no branch name in pipeline state — cannot look up the reviewed identity");
  }
  const remote = await remoteName(execFn, repoRoot);
  if (!remote) {
    return refusal(
      "no git remote found (origin/upstream/first) — the reviewed identity cannot be checked",
    );
  }
  const mainline = await resolveMainlineForHead(execFn, repoRoot, remote);
  if (!mainline.ok) return refusal(mainline.reason);
  return { ok: true, grouped: false, remote, mainline: mainline.mainline };
}

/**
 * Fetch, read, compare. Everything after the cheap refusals: this is the half
 * that touches the network and the ledger, and every fault in it is a refusal.
 */
export async function compareFetchedHead(
  execFn: VerifyExecFn,
  repoRoot: string,
  branch: string,
  headOid: string,
  remote: string,
  mainline: string,
): Promise<HeadCheck> {
  // The refs must be current before any identity is computed: a local clone
  // that has not seen the latest push would report the OLD patch identity and
  // the step would merge a head it never fetched. Fail closed on a failed
  // fetch — a merge on stale refs is exactly the failure this check exists for.
  const problem = netRefProblem(remote, branch, mainline);
  if (problem !== undefined) return refusal(`git fetch refused: ${problem}`, headOid);
  try {
    await runNetGit(execFn, "git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      timeoutMs: EXEC_TIMEOUT_MS,
      argv: ["fetch", remote, branch, mainline],
    });
  } catch (err) {
    return refusal(
      `git fetch of ${remote}/${branch} failed: ${(err as Error).message?.slice(0, 160)}`,
      headOid,
    );
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
    return refusal(`could not read the fetched head ${remote}/${branch}`, headOid);
  }

  const ledgerPath = await ledgerPathFor(execFn, repoRoot);
  if (!ledgerPath) {
    return refusal(
      "no git common dir found — the review ledger is unavailable, so the reviewed identity cannot be checked",
      headOid,
      foundHead,
    );
  }
  // `readLedgerAt` never throws today (every fs and parse fault is swallowed to
  // "no rows"); the try/catch keeps a torn file a refusal rather than a merge
  // whatever its current contract says. The empty case falls through to the
  // comparison, whose `no-entry` refusal is the honest wording.
  let entries: LedgerEntry[] = [];
  try {
    entries = readLedgerAt(ledgerPath);
  } catch (err) {
    return refusal(
      `the review ledger could not be read (${(err as Error).message?.slice(0, 120)})`,
      headOid,
      foundHead,
    );
  }

  const identity = await mergeIdentity(execFn, repoRoot, branch, mainline);
  if (!identity.ok) {
    return refusal(
      `could not compute the patch identity of ${branch}: ${identity.reason}`,
      headOid,
      foundHead,
    );
  }

  const verdict = compareAdversarialIdentity(entries, branch, identity.patchId);
  if (!verdict.ok) {
    return refusal(describeMismatch(verdict), headOid, foundHead);
  }
  return {
    ok: true,
    headOid,
    note: `reviewed identity confirmed for ${branch} (patchId ${verdict.patchId.slice(0, 8)})`,
  };
}

/** The mismatch, in the operator's words: what was reviewed vs what is there. */
function describeMismatch(
  verdict: Exclude<ReturnType<typeof compareAdversarialIdentity>, { ok: true }>,
): string {
  const reviewed = "entry" in verdict ? verdict.entry.patchId.slice(0, 8) : "none";
  const detail =
    verdict.cause === "patch-changed"
      ? `the reviewed patch ${verdict.reviewedPatchId.slice(0, 8)} ≠ the head's ${verdict.currentPatchId.slice(0, 8)}`
      : verdict.cause === "not-passed"
        ? `the latest adversarial row did not pass (patchId ${verdict.entry.patchId.slice(0, 8)})`
        : `no adversarial row on file for \`${verdict.branch}\``;
  return `the head was not the reviewed one: reviewed ${reviewed} — ${detail}`;
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

// (no second import block — `readLedgerAt` is in the top group above)
