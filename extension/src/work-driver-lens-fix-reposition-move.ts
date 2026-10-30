/**
 * work-driver-lens-fix-reposition-move — #1882 — the two helpers the
 * round-2+ reposition gate needs to ACCEPT a tree whose commits live on the
 * remote rather than on the (lagging) local branch ref.
 *
 * The gate's tip comes from `resolveBranchTip`, which prefers the NEWER of
 * `refs/heads/<branch>` and `refs/remotes/origin/<branch>`. When the driver
 * pushed its own lens-fix commit and left the local ref behind — `integrate()`
 * pushes at repoRoot and restores the checkout, and `landCommittedFix()`'s
 * verified restore does the same — the tip is the STALE local ref and the
 * cycle's own pushed work reads as "commits the branch does not", which parked
 * `lens-fix-reposition` (the top stop reason measured in the field). These two
 * helpers are the gate's second opinion: read the tree against the remote
 * (`readAgainstRemote`), and when the remote accounts for it, back the tree up
 * and move it to the tip (`moveToTip`).
 *
 * Split from work-driver-lens-fix-reposition-gate.ts for the AGENTS.md §12
 * 500-line gate. All git commands run through the `ExecFn` argv form.
 */
import { trace, traceWarn } from "./trace.ts";
import { hardenedGitArgv } from "./work-driver-fix-pass-strays.ts";
import { backupLensFixTree } from "./work-driver-lens-fix-reposition-backup.ts";
import type { RepositionResult } from "./work-driver-lens-fix-reposition-gate.ts";
import {
  GIT_TIMEOUT_MS,
  cherryLines,
  rangeAllNonEmpty,
} from "./work-driver-lens-fix-reposition-queries.ts";
import type { ExecFn } from "./worktree.ts";

const TRACE_PREFIX = "lens-fix-reposition";

/**
 * A commit id, as the driver accepts one. FULL 40-hex lowercase: the shapes
 * reaching here are the output of `rev-parse` or a fetched remote-tracking
 * ref, never an abbreviation, and `moveToTip` compares its result to this
 * string byte-for-byte — a 7-char form would let a truncated capture pass
 * the guard and then fail the comparison as a "checkout did not land".
 */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * #1882 — read the tree against the REMOTE tip. `allLanded` requires every
 * tree commit `git cherry` marks `-` AND the `rangeAllNonEmpty` verification
 * (the same empty-patch-id guard the tip path applies), because `git cherry`'s
 * contract covers only non-empty patches. `undefined` when there is no remote
 * ref to compare against or the cherry read failed — the caller then judges
 * the tree against the tip alone, exactly as before #1882.
 */
export async function readAgainstRemote(
  execFn: ExecFn,
  tree: string,
  treeSha: string,
  remoteTipSha: string,
): Promise<{ tipSha: string; allLanded: boolean } | undefined> {
  const lines = await cherryLines(execFn, tree, remoteTipSha, treeSha);
  if (lines === undefined) return undefined;
  const plus = lines.filter((line) => line.startsWith("+")).length;
  const allLanded =
    plus === 0 && (await rangeAllNonEmpty(execFn, tree, remoteTipSha, treeSha)) === true;
  return { tipSha: remoteTipSha, allLanded };
}

/**
 * #1882 — move a CLEAN worktree onto `tipSha` after backing it up. The two
 * accept paths (tip cherry-landed, and remote cherry-landed for a `+`-against-
 * local whose commits the remote holds) both run through it, so neither can
 * forget the backup ref that keeps the detach from orphaning HEAD, nor the
 * post-checkout
 * verification that the tree really landed on the tip. Fail closed: no backup
 * ref means no move. `why` is the trace clause naming which read accepted.
 */
export async function moveToTip(
  execFn: ExecFn,
  tree: string,
  branchName: string,
  issues: number[],
  issueTitle: string | undefined,
  treeSha: string,
  /** Where the tree should land. The tip cherry arm passes the resolved tip;
   *  the remote cherry arm passes the REMOTE tip, which is the commit the move
   *  was justified against — moving it to the local tip would re-create the
   *  park the arm exists to close. */
  tipSha: string,
  why: string,
): Promise<RepositionResult> {
  if (!SHA_RE.test(tipSha)) {
    // Refuse before the backup ref or the checkout: a non-commit id reaching
    // here means a caller passed prose or a truncated capture, and git would
    // resolve it against a working tree we do not own.
    traceWarn(
      `${TRACE_PREFIX}: refused to move the tree — ${tipSha.slice(0, 12)} is not a commit id`,
    );
    return { kind: "git-failed", detail: `${tipSha} is not a commit id` };
  }
  const backup = await backupLensFixTree(execFn, tree, branchName, issues, issueTitle);
  const backupRef = backup.ref;
  if (backupRef === undefined) {
    // Fail closed: without the backup ref the detach checkout would orphan
    // the old HEAD with no way back, so the tree must NOT move. The backup
    // helper's git error rides in the detail (first line, ≤200 chars) so the
    // operator knows WHY the ref was not created.
    const detail = `backup ref could not be created (${backup.error ?? "git error"}); refusing to move a tree that is not a fast-forward`;
    trace(`${TRACE_PREFIX}: ${detail}`);
    return { kind: "diverged", detail };
  }
  try {
    await execFn("git", {
      cwd: tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      argv: hardenedGitArgv(["checkout", "--detach", "--quiet", tipSha]),
    });
    const hp = await execFn("git", {
      cwd: tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      argv: hardenedGitArgv(["rev-parse", "HEAD"]),
    });
    const movedSha = hp.stdout.trim();
    if (movedSha !== tipSha) {
      const detail = `checkout to the tip did not land on the tip (expected ${tipSha.slice(0, 12)}, got ${movedSha.slice(0, 12)})`;
      traceWarn(`${TRACE_PREFIX}: ${detail}`);
      return { kind: "git-failed", detail, backupRef };
    }
    trace(
      `${TRACE_PREFIX}: repositioned ${treeSha.slice(0, 12)} -> ${movedSha.slice(0, 12)} (backed up to ${backupRef}, patch-equivalence) — ${why}`,
    );
    return {
      kind: "repositioned",
      fromSha: treeSha,
      tipSha,
      backupRef,
    };
  } catch (e) {
    traceWarn(`${TRACE_PREFIX}: checkout to tip failed: ${e}`);
    return {
      kind: "git-failed",
      detail: `git checkout --detach ${tipSha.slice(0, 12)} failed: ${e}`,
      backupRef,
    };
  }
}
