/**
 * work-driver-lens-fix-commit — #749: committed-work-aware lens-fix
 * detection.
 *
 * The `!result.committed` branch of runAdversarial and runLensFix's
 * resend path used to answer "did the lens-fix produce a fix" with
 * `git status --porcelain` — a check that can only ever observe
 * UNCOMMITTED changes. A lens-fix developer that commits its work (what a
 * developer asked to fix findings ordinarily does) makes the tree clean and
 * is invisible to the check: the driver parks `lens-fix-not-integrated`
 * with evidence "git status --porcelain … was empty" while the fix sits
 * stranded in the worktree on no branch (issue #745's live incident).
 *
 * The correct measurement is committed work:
 *   - `git rev-list --count <branchHead>..HEAD` in the worktree counts the
 *     commits the fixer produced beyond what the feature branch holds —
 *     the no-baseSha followup path never cherrypicks, so the count is the
 *     fix.
 *   - `git diff <branchHead> HEAD --name-only` (a non-empty name-set) is
 *     the "is the content already on the branch" test: identical trees
 *     yield an empty diff, so a clean count alone is not enough — a fix
 *     whose content the branch already carries needs no landing, while a
 *     fix the branch lacks must be landed or parked with evidence naming
 *     the commit that exists and the branch that lacks it.
 *
 * Staging a followup's committed work onto the branch reuses the same
 * machinery commit-pr uses (`orchestrateCherryPick` with the cycle's
 * baseSha, so tree-hash dedup keeps an already-applied pick a skip, not a
 * duplicate).
 */

import { orchestrateCherryPick } from "./work-driver-cherry-pick.ts";
import { withIntegrationLock } from "./work-driver-integrate.ts";
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import { type ExecFn, sweepBranchHolders } from "./worktree.ts";

/**
 * The number of commits the fixer made in `tree` beyond the feature
 * branch's current head, or undefined when the count could not be read.
 * `0` (a count of zero commits) is a MEASURED empty — the fixer produced
 * no committed fix — and is deliberately distinct from `undefined`.
 */
export async function countCommittedAhead(
  execFn: ExecFn,
  tree: string,
  branchName: string,
): Promise<number | undefined> {
  const ref = `"refs/heads/${branchName}"..HEAD`;
  const refRemote = `"refs/remotes/origin/${branchName}"..HEAD`;
  try {
    let stdout: string;
    try {
      ({ stdout } = await execFn(`git rev-list --count ${ref}`, {
        cwd: tree,
        maxBuffer: 64 * 1024,
      }));
    } catch {
      ({ stdout } = await execFn(`git rev-list --count ${refRemote}`, {
        cwd: tree,
        maxBuffer: 64 * 1024,
      }));
    }
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The name-set of `git diff <branchHead> HEAD --name-only` in `tree`, or
 * undefined when the diff could not be read. An EMPTY name-set means the
 * work is content-identical to the branch head (already on the branch); a
 * NON-EMPTY name-set means the branch lacks the fix's content.
 */
export async function diffAgainstBranch(
  execFn: ExecFn,
  tree: string,
  branchName: string,
): Promise<string[] | undefined> {
  const ref = `"refs/heads/${branchName}"`;
  const refRemote = `"refs/remotes/origin/${branchName}"`;
  try {
    let stdout: string;
    try {
      ({ stdout } = await execFn(`git diff ${ref} HEAD --name-only`, {
        cwd: tree,
        maxBuffer: 1024 * 1024,
      }));
    } catch {
      ({ stdout } = await execFn(`git diff ${refRemote} HEAD --name-only`, {
        cwd: tree,
        maxBuffer: 1024 * 1024,
      }));
    }
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return undefined;
  }
}

/**
 * Stage the tree's committed work (baseSha..HEAD) onto the feature branch
 * at repoRoot via the commit-pr cherry-pick machinery. Returns the SHA of
 * the tree's HEAD on success — the evidence a park string can quote — or
 * an error string when the batch could not land. On ANY failure the caller
 * parks; this function restores repoRoot first (verified, inside the
 * integration lock) and names the outcome in the error text.
 */
export async function landCommittedFix(
  execFn: ExecFn,
  ctx: { repoRoot: string; issue: number },
  ps: PipelineState,
  tree: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const branchName = ps.branchName;
  if (!branchName) return { ok: false, error: "no branch name recorded" };
  if (!ps.baseSha) {
    return { ok: false, error: "no baseSha recorded — cannot measure the committed range" };
  }
  // #797 — where repoRoot's checkout was before integration touched it
  // (the #782 incident left it on the feature branch mid-merge; a restore
  // to a hardcoded mainline would be wrong for a cycle that started on a
  // feature branch). Captured BEFORE the lock: the lock never mutates the
  // checkout, and if the checkout fails below, originalRef is what the
  // pre-lock failure needs.
  const originalRef = await execFn("git symbolic-ref --quiet --short HEAD", {
    cwd: ctx.repoRoot,
    maxBuffer: 64 * 1024,
  })
    .then((r) => r.stdout.trim())
    .catch(async () =>
      (
        await execFn("git rev-parse HEAD", { cwd: ctx.repoRoot, maxBuffer: 64 * 1024 })
      ).stdout.trim(),
    );
  try {
    const { stdout } = await execFn("git rev-parse HEAD", { cwd: tree, maxBuffer: 64 * 1024 });
    const sha = stdout.trim();
    if (sha.length < 7) return { ok: false, error: "could not read the worktree's HEAD" };
    const scratch = scratchDir(ctx.repoRoot, ctx.issue);
    // #797 — every failure below (checkout, cherry-pick conflict, commit,
    // no-op) runs through the verified restore BEFORE the lock is released:
    // the operator may find repoRoot on the wrong ref or with unmerged index
    // entries if the restore is left to nothing. The worktree is untouched —
    // the fixer's commits survive in `tree` either way.
    await withIntegrationLock(ctx.repoRoot, async () => {
      // #776 — a clean worktree holding the branch blocks `git checkout`
      // ("fatal: '<branch>' is already used by worktree at '…'"). Sweep it
      // first, the same way integrate() followup mode does.
      await sweepBranchHolders(execFn, ctx.repoRoot, branchName);
      await execFn(`git checkout ${JSON.stringify(branchName)}`, {
        cwd: ctx.repoRoot,
        maxBuffer: 256 * 1024,
      });
      const orch = await orchestrateCherryPick(execFn, {
        repoRoot: ctx.repoRoot,
        branchName,
        worktrees: { ids: ["lens-fix"], worktrees: { "lens-fix": tree }, commitShas: {} },
        baseSha: ps.baseSha,
        scratchDir: scratch,
        requireAllNonEmpty: false,
      });
      const { stdout: stagedOut } = await execFn("git diff --cached --name-only", {
        cwd: ctx.repoRoot,
        maxBuffer: 64 * 1024,
      });
      if (stagedOut.trim()) {
        await execFn(`git commit -q -m 'fix(lens): round 1 review findings'`, {
          cwd: ctx.repoRoot,
          maxBuffer: 64 * 1024,
        });
      }
      if (orch._conflict === "conflict" || orch._applyConflict !== undefined) {
        const restore = await verifiedRestoreRoot(execFn, {
          repoRoot: ctx.repoRoot,
          originalRef,
          scratchDir: scratch,
          label: "lens-fix-integration",
        });
        const causeMsg =
          orch._conflict === "conflict"
            ? "cherry-pick conflict — the batch was aborted"
            : `patch-apply failed for the lens-fix worktree: ${orch._applyConflict?.reason ?? "unknown"}`;
        throw new Error(
          `${causeMsg}. ${restoreClaim(restore, "", MANUAL_REPAIR_HINT)} The fix's commits remain in the worktree ${tree}.`,
        );
      }
      // #749 — the tree-hash dedup skip means the content is already on the
      // branch (not a failure); the caller re-reviews. A genuine no-op —
      // no commits landed AND no skip was measured — is a failure.
      if (orch.cherryApplied.length === 0 && orch.skippedAlreadyOnBranch.length === 0) {
        const restore = await verifiedRestoreRoot(execFn, {
          repoRoot: ctx.repoRoot,
          originalRef,
          scratchDir: scratch,
          label: "lens-fix-integration",
        });
        throw new Error(
          `nothing landed on the branch. ${restoreClaim(restore, "", MANUAL_REPAIR_HINT)}`,
        );
      }
    });
    return { ok: true, sha };
  } catch (err) {
    const msg = (err as Error).message ?? "unknown error";
    // #797 — a thrown failure inside the lock (commit failure with an
    // unmerged index, a checkout throw, …) gets the same verified restore as
    // the explicit conflict/no-op paths. A failure that already carries a
    // restore claim (the conflict/no-op throws above) is not restored
    // twice — the claim names the outcome either way.
    if (!msg.includes("repoRoot was")) {
      const restore = await verifiedRestoreRoot(execFn, {
        repoRoot: ctx.repoRoot,
        originalRef,
        scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
        label: "lens-fix-integration",
      });
      return {
        ok: false,
        error: `${msg.slice(0, 200)}. ${restoreClaim(restore, "", MANUAL_REPAIR_HINT)} The fix's commits remain in the worktree ${tree}.`,
      };
    }
    return { ok: false, error: msg.slice(0, 300) };
  }
}

/**
 * #797 — the trailing text appended to every lens-fix integration failure
 * claim. The verified-restore claim alone ("repoRoot was restored …") leaves
 * an operator with no next step, and the not-restored variant must carry the
 * repair commands the issue's acceptance criteria require: a failed restore
 * is a more serious condition than the integration failure and names the
 * exact commands that return repoRoot to a usable state.
 */
const MANUAL_REPAIR_HINT =
  "If repoRoot is not usable, repair it with: git reset --hard && git checkout --force <the ref the cycle started from> (run `git status` and `git branch --show-current` to see the current state)";

/**
 * #797 — the ref a lens-fix integration cycle started from at repoRoot
 * (the symbolic ref, falling back to the raw SHA for a detached HEAD), or
 * undefined when the read failed. The handoff renderer uses this to state
 * the restore post-condition: after a failed integration, repoRoot must be
 * on this ref again.
 */
export async function repoRootOriginalRef(
  execFn: ExecFn,
  repoRoot: string,
): Promise<string | undefined> {
  try {
    return await execFn("git symbolic-ref --quiet --short HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    })
      .then((r) => r.stdout.trim())
      .catch(async () =>
        (await execFn("git rev-parse HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 })).stdout.trim(),
      );
  } catch {
    return undefined;
  }
}

/**
 * Classify what the lens-fix produced, measuring committed work (not just
 * uncommitted changes). `committedCount` is the count of commits the fixer
 * made beyond the branch head; `diffEmpty` is whether
 * `git diff <branch> HEAD` is an empty name-set (content already on the
 * branch). `null` for either measurement means the git read failed —
 * callers park with the read failure as evidence rather than guessing.
 */
export type LensFixCommittedStatus =
  | { status: "committed"; count: number; diffEmpty: boolean }
  | { status: "no-commits"; count: number | null }
  | { status: "unmeasurable" };

export async function detectCommittedFix(
  execFn: ExecFn,
  tree: string,
  branchName: string,
): Promise<LensFixCommittedStatus> {
  const count = await countCommittedAhead(execFn, tree, branchName);
  if (count === undefined) return { status: "unmeasurable" };
  if (count === 0) return { status: "no-commits", count: 0 };
  const diff = await diffAgainstBranch(execFn, tree, branchName);
  if (diff === undefined) return { status: "unmeasurable" };
  return { status: "committed", count, diffEmpty: diff.length === 0 };
}

/**
 * Evidence string for the genuinely-empty followup: names the detection
 * actually performed (a committed-work count against the branch head) and
 * never cites an uncommitted-changes check as evidence about whether
 * commits landed (#749's AC6).
 */
export function noDiffEvidence(tree: string, branchName: string, count: number | null): string {
  const measured = count === null ? "could not be read (git error)" : `count is ${count}`;
  return `no committed fix: the lens-fix worktree ${tree} has ${count === null ? "no readable" : count} commit(s) ahead of branch ${branchName} (rev-list --count ${branchName}..HEAD ${measured})`;
}
