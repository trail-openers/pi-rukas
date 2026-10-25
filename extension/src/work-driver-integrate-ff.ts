/**
 * work-driver-integrate-ff — #1468: integrate step 3 for `--continue-pr`.
 * The worktree HEAD is the PR head with the mainline merged in, so the
 * branch is fast-forwarded to it. A cherry-pick would fail on the merge
 * commit and drop its second parent.
 *
 * The commit this step makes is a PUBLISH (#1788 round 6): `title` and `body`
 * are the strings `runCommitPr` derived from the issue, and the `tool_call`
 * guard never sees them — they reach git inside the driver's own exec, so
 * there is no shell command for a hook to read. They therefore go through the
 * same commit-message seam `work-driver-commit.ts` uses, and a refusal returns
 * a structured `apply` failure WITHOUT committing: the caller restores the
 * checkout and parks with the reason, exactly as it does for a cherry-pick
 * conflict.
 */

import { trace } from "./trace.ts";
import type { OrchestratedCherryPickResult } from "./work-driver-cherry-pick.ts";
import { commitMessageToPublish } from "./work-driver-commit-message-publish.ts";
import { stagePorcelainPaths } from "./work-driver-stage.ts";
import { type ExecFn, gitErrorDetail } from "./worktree.ts";

/** What `fastForwardOnto` returns: the cherry-pick shape, or the refusal reason. */
export type FastForwardOutcome =
  | OrchestratedCherryPickResult
  | { _publishRefusal: { reason: string; committed: boolean } };

/**
 * Commit each worktree's uncommitted work onto its HEAD, then
 * `merge --ff-only` that HEAD at repoRoot; a refusal returns rather than throws.
 * The commit does what the patch fallback does for a cherry-pick: a developer
 * leaves edits uncommitted, and a fast-forward alone would push the branch
 * without them.
 *
 * The message check runs BEFORE the first worktree is staged, because a
 * half-committed batch is the worst outcome: the operator would have N-1
 * commits carrying the private term on the branch this step fast-forwards.
 * `committed` reports whether any worktree was committed before the refusal,
 * which is always `false` today — it is the field the caller would read if the
 * order ever moved.
 *
 * The message COMMITTED is the message JUDGED (#1820): the seam returns the
 * normalised title/body and this loop passes THOSE to `git commit -m`, never the
 * `commit.title`/`commit.body` it was handed. On a public target the seam rewrites
 * host paths to `<repo>`/`~`; committing the caller's originals would have made
 * that rewrite a no-op here while the check still read the rewritten bytes.
 */
export async function fastForwardOnto(
  execFn: ExecFn,
  repoRoot: string,
  ids: string[],
  worktrees: Record<string, string>,
  commit: { title: string; body: string; exempt?: readonly string[] },
  /** The issue the message derives from — named in the refusal only. */
  issue?: number,
): Promise<FastForwardOutcome> {
  const message = await commitMessageToPublish(
    execFn,
    { commitTitle: commit.title, commitBody: commit.body, issue },
    repoRoot,
  );
  if (message.refusal !== undefined) {
    trace(`work-driver: integrate — fast-forward commit refused for #${issue ?? "?"}`);
    return { _publishRefusal: { reason: message.refusal, committed: false } };
  }
  for (const id of ids) {
    const wt = worktrees[id];
    if (!wt) throw new Error(`worktree '${id}' has no path`);
    if ((await stagePorcelainPaths(execFn, wt, commit.exempt)) > 0) {
      await execFn("git", {
        argv: ["commit", "-m", message.title, "-m", message.body],
        cwd: wt,
      });
    }
    const head = (await execFn("git", { argv: ["rev-parse", "HEAD"], cwd: wt })).stdout.trim();
    await execFn("git", { argv: ["merge", "--ff-only", head], cwd: repoRoot });
  }
  return {
    cherryApplied: ids,
    cherryPickShas: {},
    skippedAlreadyOnBranch: [],
    patchApplied: [],
    noDiff: {},
    emptyWorkstreams: [],
    hadNewCommits: true,
  };
}

/**
 * Put the local branch back to `from` after a fast-forward that was not
 * pushed, so a re-entry compares the worktree with what origin holds and
 * finds its work again. A compare-and-swap: a branch something else moved,
 * or one repoRoot has checked out, is left alone. The worktrees keep their
 * commits.
 */
export async function rewindFastForward(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
  from: string,
): Promise<void> {
  const ref = `refs/heads/${branchName}`;
  try {
    const cur = (
      await execFn("git", { argv: ["rev-parse", "-q", "--verify", ref], cwd: repoRoot })
    ).stdout.trim();
    if (cur === from) return;
    const held = await execFn("git", { argv: ["symbolic-ref", "-q", "HEAD"], cwd: repoRoot })
      .then((r) => r.stdout.trim())
      .catch(() => "");
    if (held === ref) {
      trace(`work-driver: integrate — not rewinding ${branchName}, repoRoot has it checked out`);
      return;
    }
    await execFn("git", { argv: ["update-ref", ref, from, cur], cwd: repoRoot });
    trace(`work-driver: integrate — rewound unpushed ${branchName} to ${from.slice(0, 8)}`);
  } catch (err) {
    trace(
      `work-driver: integrate — could not rewind ${branchName}: ${gitErrorDetail(err).slice(0, 200)}`,
    );
  }
}
