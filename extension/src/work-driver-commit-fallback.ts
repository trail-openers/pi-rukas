import { trace } from "./trace.ts";
import { conflictArtifactFromPlumb } from "./work-driver-commit-helpers.ts";
import { deriveCommitPrTitle } from "./work-driver-commit-title.ts";
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
 * forbids the repo root's checkout and every other .worktrees directory path.
 */
import type { DriverContext } from "./work-driver-context.ts";
import { ensureIntegrateWorktree } from "./work-driver-integrate-worktree.ts";
import { integrateWorktreePath } from "./work-driver-integrate-worktree.ts";
import { runSingleDispatch } from "./work-driver-merged.ts";
import { inlineCommitPrPrompt } from "./work-driver-prompts-late.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";
import { workStateFile } from "./workflow-state.ts";
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
  // repo root's checkout and every other .worktrees directory path.
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

/**
 * #861 — the integrate-worktree creation + creation-failure halt block
 * (extracted from mechanizedCommitPr in work-driver-commit.ts).
 *
 * On a non-terminal failure the ops fallback takes over, so the driver
 * creates the worktree the fallback is pinned to, HERE:
 * (a) it sits INSIDE withIntegrationLock (runCommitPr wraps
 * mechanizedCommitPr) — the tree will hold the integration branch and
 * a sibling's sweep/integration must not race it; (b) `res.conflictPatch`
 * is in scope — the patch path is passed STRUCTURALLY to the prompt
 * (the "where possible" in the decision), never re-parsed from reason;
 * (c) a tree-creation failure does NOT dispatch: the fallback's ONLY
 * permitted working tree would not exist (a cwd-less / repoRoot-cwd
 * dispatch is exactly the #841 defect class — the prompt forbids both
 * repoRoot and the workstream worktrees, and the strict audit would
 * halt a child that worked there anyway). A failure to create the
 * integrate worktree is a driver environment failure → a cap, not an
 * LLM judgment call.
 *
 * Returns `{ path, state }` on success (the state records the path in
 * `pipelineState.integrateWorktree` so a re-entry after a crash recognises
 * a driver-owned tree and REPLACES it (decision (2))); `{ halted }` on a
 * creation failure (the state already carries the plumb + cap).
 */
export async function ensureIntegrateWorktreeOrHalt(
  ctx: DriverContext,
  state: WorkState,
  branchName: string,
  execFn: ExecFn,
): Promise<{ path: string; state: WorkState } | { halted: WorkState }> {
  const ps = state.pipelineState;
  if (!ps.baseSha) {
    return { path: integrateWorktreePath(ctx.repoRoot, ctx.issue), state };
  }
  try {
    const created = await ensureIntegrateWorktree(
      execFn,
      {
        repoRoot: ctx.repoRoot,
        issue: ctx.issue,
        branchName,
        baseSha: ps.baseSha,
      },
      workStateFile(ctx.repoRoot, ctx.issue),
    );
    const next: WorkState = {
      ...state,
      pipelineState: { ...state.pipelineState, integrateWorktree: created.path },
    };
    return { path: created.path, state: next };
  } catch (rawErr) {
    const err = rawErr as Error & { stderr?: string };
    const detail = (err.stderr ?? err.message ?? "").toString();
    trace(
      `work-driver: integrate worktree creation failed — halting (no unpinned ops dispatch): ${detail.slice(0, 200)}`,
    );
    const capBody = `integrate worktree could not be created: ${detail.slice(0, 200)}`;
    const halted: WorkState = appendEvent(
      appendEvent(state, {
        kind: "plumb-report",
        at: Date.now(),
        step: "commit-pr",
        role: "driver",
        body: "The driver-owned integrate worktree could not be created; the commit-pr ops fallback is pinned to it as the ONLY permitted working tree, so no ops dispatch is attempted.",
        fallbackCause: "other",
      }),
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: "integration-worktree-violation",
        evidence: capBody,
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      },
    );
    return { halted };
  }
}
