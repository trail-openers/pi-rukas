/**
 * work-driver-commit-reentry — what a SECOND commit-pr of a cycle may do.
 *
 * commit-pr is re-entered two ways once the cycle's PR exists: a resume after
 * a crash past `prCreate` (nothing new to ship), and the re-fix loop
 * (`ci-status: failure → develop → adversarial → commit-pr`), where the
 * developer's fix is sitting in the worktree on no branch. The re-entry guard
 * in `mechanizedCommitPr` only knew the first: an open PR meant "skip
 * integrate", so a CI fix was reported as shipped, never pushed, and `ci`
 * watched the same red head until the retry cap.
 *
 * The two are told apart by MEASURING the worktrees against the branch
 * (`worktreesWithNewWork`), and new work lands via `integrate()` in followup
 * mode from the branch's own head (`branchHeadOf`) — the existing branch is
 * extended and the push is a fast-forward, never `checkout -B <base>`.
 *
 * A PR that was merged or closed meanwhile is neither case: rebuilding the
 * branch from base and pushing over the remote is what the old code did
 * (`prGoneRefusal`).
 */

import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { PR_NOT_OPEN_MARKER } from "./work-driver-explain-verify.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Workstream ids whose worktree holds work the branch does not: commits ahead
 * of `refs/heads/<branch>`, or an uncommitted change. An unreadable worktree
 * counts as no new work — the guard then behaves as it did before (skip), and
 * the miss is traced rather than turned into a branch rewrite.
 */
export async function worktreesWithNewWork(
  execFn: VerifyExecFn,
  worktrees: Record<string, string>,
  branchName: string,
): Promise<string[]> {
  const pending: string[] = [];
  for (const [id, wt] of Object.entries(worktrees)) {
    try {
      const { stdout: ahead } = await execFn(
        `git rev-list --count ${JSON.stringify(`refs/heads/${branchName}`)}..HEAD`,
        { cwd: wt, maxBuffer: 64 * 1024 },
      );
      if (Number.parseInt(ahead.trim(), 10) > 0) {
        pending.push(id);
        continue;
      }
      const { stdout: dirt } = await execFn("git status --porcelain", {
        cwd: wt,
        maxBuffer: 1024 * 1024,
      });
      if (dirt.trim()) pending.push(id);
    } catch (err) {
      trace(
        `work-driver: commit-pr re-entry — could not measure worktree '${id}' against ${branchName}: ${(err as Error).message?.slice(0, 160)}`,
      );
    }
  }
  return pending;
}

/** The local branch's head — the base a second round integrates onto. */
export async function branchHeadOf(
  execFn: VerifyExecFn,
  repoRoot: string,
  branchName: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFn(
      `git rev-parse --verify --quiet ${JSON.stringify(`refs/heads/${branchName}^{commit}`)}`,
      { cwd: repoRoot, maxBuffer: 64 * 1024 },
    );
    return /^[0-9a-f]{40}$/.test(stdout.trim()) ? stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The state of the PR this cycle already opened, when no OPEN PR heads the
 * branch. `OPEN` (the list missed it) → the caller treats it as the existing
 * PR; `MERGED` / `CLOSED` → `gone`. Anything unreadable, or a PR on another
 * branch, is `undefined`: the caller proceeds as a first round, as before.
 */
export async function recordedPrState(
  ctx: DriverContext,
  execFn: VerifyExecFn,
  prNumber: number | undefined,
  branchName: string,
): Promise<"OPEN" | "MERGED" | "CLOSED" | undefined> {
  if (prNumber === undefined) return undefined;
  try {
    const pr = await (await forgeForCycle(ctx, execFn))?.prView(prNumber);
    return pr?.headRefName === branchName ? pr.state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The cycle's PR is no longer open, so there is nothing to push a second round
 * onto. Parks with the same cap and wording the post-commit-pr identity gate
 * uses for a non-OPEN PR, BEFORE anything is rebuilt or pushed.
 */
export function prGoneRefusal(
  state: WorkState,
  prNumber: number,
  branchName: string,
  prState: "MERGED" | "CLOSED",
): { reason: string; haltedAfter: WorkState } {
  const reason = `PR #${prNumber} is ${prState}, not OPEN — a second commit-pr has nothing to push onto, and ${branchName} was NOT rebuilt from base or pushed. The new work is still in the cycle's worktree(s).`;
  const haltedAfter = appendEvent(
    {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        verifyEvidence: {
          step: "commit-pr",
          failures: [`${PR_NOT_OPEN_MARKER} ${reason}`],
          at: Date.now(),
        },
      },
    },
    { kind: "plumb-report", at: Date.now(), step: "commit-pr", role: "driver", body: reason },
    {
      kind: "cap-hit",
      at: Date.now(),
      cap: "verify-failed:commit-pr",
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
    },
  );
  return { reason, haltedAfter };
}
