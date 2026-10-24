/**
 * work-driver-handoff-capped-pr — #1402: an adversarial-loop cap keeps its work
 * reachable as a pushed branch and a DRAFT PR.
 *
 * At the last adversarial round only `CRITICAL_ISSUES_FOUND` blocks (#664), so
 * the `adversarial-loop` cap means the final verdict was CRITICAL. That cap
 * routes from adversarial straight to handoff — commit-pr never runs — and the
 * handoff consolidation is local-only by design, so the reviewed commits ended
 * on a branch only the parked workspace could see (a measured cycle: three fix
 * rounds, a one-line CRITICAL fix the reviewer had written out, and no pushed
 * branch, no PR, nothing an operator could fetch before the workspace sweep).
 *
 * This runs after the consolidation and before the snapshot, so the handoff
 * describes the world it leaves: push the consolidated branch, open a draft PR
 * whose body carries the reviewer's findings, and record `prNumber` /
 * `prDraft: draft` so the comment and label land on the PR. The draft is the
 * safety: it cannot be merged with `gh pr merge`, handoff is terminal, and
 * `settleDraftPrAtHandoff` leaves a draft alone when no lens review concluded —
 * so nothing on this path marks it ready or reaches the merge-authority gate.
 * The body says `Refs`, not `Fixes`: a rejected change must not close its issue.
 *
 * Scoped to the one cap that skips commit-pr with reviewed work in hand, and
 * only when the cycle has no PR yet (a later-round adversarial cap already has
 * one). Any failure degrades to the status quo — a local branch and the
 * per-worktree recovery — and never blocks the handoff. Escape hatch
 * `PI_ENSEMBLE_HANDOFF_DRAFT_PR=0`.
 */

import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import { deriveCommitPrTitle } from "./work-driver-commit-title.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { adversarialOutcomeSection } from "./work-driver-handoff-adversarial.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";

/** The cap the cycle stopped on (the latest cap-hit), if any. */
function latestCap(state: WorkState): string | undefined {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === "cap-hit") return e.cap;
  }
  return undefined;
}

/** The draft PR's body: what it is, which issue, and what the reviewer found. */
export function cappedDraftPrBody(state: WorkState): string {
  return [
    "**Draft — not ready to merge.** The adversarial gate rejected this change at its",
    "round cap (`CRITICAL_ISSUES_FOUND`). It is opened so the reviewed work is reachable;",
    "resolve the findings below before marking it ready.",
    "",
    ...activeIssuesOf(state).map((n) => `Refs #${n}`),
    "",
    ...adversarialOutcomeSection(state),
  ].join("\n");
}

export async function openDraftPrForCappedWork(
  ctx: Pick<DriverContext, "repoRoot" | "issue" | "forge">,
  state: WorkState,
): Promise<WorkState> {
  if (process.env.PI_ENSEMBLE_HANDOFF_DRAFT_PR === "0") return state;
  const ps = state.pipelineState;
  const branch = ps.branchName;
  if (latestCap(state) !== "adversarial-loop" || ps.prNumber !== undefined) return state;
  if (!branch || branch.startsWith("(") || !ps.baseSha) return state;
  try {
    // Only work that is actually on the branch — a degraded consolidation
    // leaves it in the worktrees, and the per-worktree recovery says so.
    const { stdout } = await execp(
      `git rev-list --count ${JSON.stringify(`${ps.baseSha}..${branch}`)}`,
      { cwd: ctx.repoRoot, maxBuffer: 64 * 1024 },
    );
    if (!(Number(stdout.trim()) > 0)) return state;
    const forge = ctx.forge ?? (await forgeForCycle(ctx, execp));
    if (!forge) return state;
    const refProblem = netRefProblem(branch);
    if (refProblem !== undefined) throw new Error(`push refused: ${refProblem}`);
    await runNetGit(execp, "git", { cwd: ctx.repoRoot, argv: ["push", "-u", "origin", branch] });
    const title = await deriveCommitPrTitle(state, ctx, execp);
    const pr = await forge.prCreate(title, branch, cappedDraftPrBody(state), { draft: true });
    trace(`work-driver: handoff — pushed ${branch} and opened draft PR #${pr.number}`);
    return {
      ...state,
      pipelineState: { ...ps, prNumber: pr.number, prDraft: { status: "draft" } },
    };
  } catch (err) {
    trace(`work-driver: handoff draft PR not opened (work stays local): ${(err as Error).message}`);
    return state;
  }
}
