import { deriveCommitPrTitle } from "./work-driver-commit-title.ts";
import { conflictArtifactFromPlumb } from "./work-driver-commit.ts";
/**
 * work-driver-commit-fallback — the commit-pr ops-fallback dispatch (the
 * `next === undefined` branch of runCommitPrLocked).
 *
 * Split from work-driver-commit.ts for the AGENTS.md §12 500-line cap (the
 * #861 creation-failure plumbing pushed it over). Owns the LLM ops
 * dispatch that absorbs a non-terminal mechanized commit-pr failure: the
 * spec's `cwd` is the driver-owned integrate worktree (created by
 * mechanizedCommitPr under the integration lock), and the prompt names
 * that path as the ONLY permitted working tree, the scratch dir, the
 * preserved conflict artifact (structured, from the mechanized failure),
 * the baseSha and every workstream's worktree path + committed SHA — and
 * forbids the repo root's checkout and every other .worktrees/* path.
 */
import type { DriverContext } from "./work-driver-context.ts";
import { integrateWorktreePath } from "./work-driver-integrate-worktree.ts";
import { runSingleDispatch } from "./work-driver-merged.ts";
import { inlineCommitPrPrompt } from "./work-driver-prompts-late.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

export async function dispatchCommitPrFallback(
  ctx: DriverContext,
  preDispatch: WorkState,
  now: number,
  execFn: ExecFn,
  // #861 round 2 — the structured conflict-artifact value threaded from the
  // mechanized failure (or `undefined` when no patch was preserved). The
  // prompt's conflict section reads it directly, never re-parsing the
  // plumb's body (the old event indirection).
  conflictPatch: string | undefined,
): Promise<WorkState> {
  // #818 — the ops fallback receives the DERIVED conventional subject (not
  // the raw issue title), so the PR the ops child opens is conventional
  // even when the mechanized path fell back. The prompt instructs it to
  // use the subject verbatim as the PR title.
  const issueTitle = await deriveCommitPrTitle(preDispatch, ctx, execFn);
  // #861 — the fallback is pinned to the driver-owned integrate worktree
  // (created by mechanizedCommitPr under the integration lock). The spec
  // carries `cwd` (the #841 defect was a cwd-less dispatch whose prompt
  // told the child to roam); the prompt carries the worktree path as the
  // ONLY permitted working tree, the scratch dir, the preserved conflict
  // artifact (structured, from the mechanized failure), the baseSha and
  // every workstream's worktree path + committed SHA — and forbids the
  // repo root's checkout and every other .worktrees/* path.
  const ps = preDispatch.pipelineState;
  const integratePath = integrateWorktreePath(ctx.repoRoot, ctx.issue);
  return runSingleDispatch(
    ctx,
    preDispatch,
    "commit-pr",
    "ops",
    "ops:commit-pr",
    now,
    () =>
      // PR14 — thread worktrees + workstreams + branchName into the prompt
      // so ops knows to consolidate every worktree's uncommitted changes
      // (not just whichever one its dispatch landed in). Pre-PR14 the
      // prompt was single-tree shaped; multi-workstream cycles silently
      // committed only one worktree's slice (v0.12.13 /work 577 incident).
      inlineCommitPrPrompt(
        activeIssuesOf(preDispatch),
        preDispatch.pipelineState.droppedIssues ?? [],
        preDispatch.pipelineState.worktrees ?? {},
        preDispatch.pipelineState.workstreams ?? {},
        preDispatch.pipelineState.branchName ?? "(branch not captured — set in Step 3)",
        preDispatch.pipelineState.normalisedSpec,
        preDispatch.eventLog,
        scratchDir(ctx.repoRoot, ctx.issue),
        issueTitle,
        {
          integratePath,
          scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
          baseSha: ps.baseSha ?? "(base not recorded)",
          conflictPatch: conflictArtifactFromPlumb(
            preDispatch.eventLog[preDispatch.eventLog.length - 1],
            conflictPatch,
          ),
          worktrees: ps.worktrees ?? {},
          commitShas: ps.commitShas ?? {},
          workstreams: ps.workstreams ?? {},
        },
      ),
    {
      cwd: integratePath,
    },
  );
}
