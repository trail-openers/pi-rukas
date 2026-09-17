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
import { scratchDir } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import type { ExecFn } from "./worktree.ts";

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
 * an error string when the batch could not land. The branch is restored on
 * failure (the caller parks; the work remains in the worktree).
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
  try {
    const { stdout } = await execFn("git rev-parse HEAD", { cwd: tree, maxBuffer: 64 * 1024 });
    const sha = stdout.trim();
    if (sha.length < 7) return { ok: false, error: "could not read the worktree's HEAD" };
    await withIntegrationLock(ctx.repoRoot, async () => {
      await execFn(`git checkout ${JSON.stringify(branchName)}`, {
        cwd: ctx.repoRoot,
        maxBuffer: 256 * 1024,
      });
      const orch = await orchestrateCherryPick(execFn, {
        repoRoot: ctx.repoRoot,
        branchName,
        worktrees: { ids: ["lens-fix"], worktrees: { "lens-fix": tree }, commitShas: {} },
        baseSha: ps.baseSha,
        scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
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
        throw new Error(
          orch._conflict === "conflict"
            ? "cherry-pick conflict — the batch was aborted and the branch was restored"
            : `patch-apply failed for the lens-fix worktree: ${orch._applyConflict?.reason ?? "unknown"}`,
        );
      }
      // #749 — the tree-hash dedup skip means the content is already on the
      // branch (not a failure); the caller re-reviews. A genuine no-op —
      // no commits landed AND no skip was measured — is a failure.
      if (orch.cherryApplied.length === 0 && orch.skippedAlreadyOnBranch.length === 0) {
        throw new Error("nothing landed on the branch");
      }
    });
    return { ok: true, sha };
  } catch (err) {
    return { ok: false, error: (err as Error).message?.slice(0, 200) ?? "unknown error" };
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
