/**
 * work-driver-lens-fix — the lens-fix step (Step 7f): the developer dispatch
 * that answers the lens findings, in the tree the review read. Split from
 * work-driver-lens.ts (500-line limit); importers take it from here.
 */

import { execp } from "./exec.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { cachedIssueTitle } from "./work-driver-integrate.ts";
import {
  countCommittedAhead,
  countLensFixEmptyResends,
  noDiffEvidence,
} from "./work-driver-lens-fix-commit.ts";
import { repositionLensFixWorktree } from "./work-driver-lens-fix-reposition-gate.ts";
import { parkLensFixReposition } from "./work-driver-lens-fix-reposition-park.ts";
import { runSingleDispatch } from "./work-driver-merged.ts";
import { inlineLensFixPrompt, scratchHygieneSection } from "./work-driver-prompts-late.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

export async function runLensFix(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // Find the most recent lens-issues-found in the log to extract findings.
  const lastFinding = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<(typeof state.eventLog)[number], { kind: "lens-issues-found" }> =>
        e.kind === "lens-issues-found",
    );
  const findings = lastFinding?.findings ?? "(no prior findings recorded)";
  // #654 — empty-diff shape: re-dispatch the fix ONCE with no-diff evidence
  // before re-flagging identical findings at escalating severity.
  const resends = countLensFixEmptyResends(state.eventLog, state.pipelineState.reviewRound);
  const fixTree = lensWorktree(ctx, state);
  // #981 — hoisted: the round-2+ reposition gate below also needs the
  // branch name; a single read of pipelineState keeps both call sites in
  // step (there were two inner declarations before the gate landed).
  const branchName = state.pipelineState.branchName;
  let next = state;
  if (resends > 0) {
    // The worktree was already established clean by the #492 inspection in
    // runAdversarial (that is what parked the cycle). Re-inspect for the
    // re-dispatch's own evidence: if it is now dirty, the previous attempt
    // left uncommitted work — commit it (that is what the prompt says), do
    // not re-dispatch blindly.
    // #749 — committed-work-aware: a clean porcelain is NOT evidence of
    // "no fix" when the fixer committed its work. Check the committed
    // count against the branch head before classifying.
    let porcelain: string | undefined;
    try {
      const execFn = ctx.verifyExecFn ?? execp;
      const { stdout } = await execFn("git status --porcelain", {
        cwd: fixTree,
        maxBuffer: 64 * 1024,
      });
      porcelain = stdout.trim();
    } catch {
      porcelain = undefined;
    }
    if (porcelain === undefined || porcelain.length > 0) {
      // Dirty tree (or unreadable — fail open to the normal dispatch, which
      // will integrate the uncommitted work through the existing gate). No
      // re-dispatch needed.
      trace(
        `work-driver: lens-fix re-dispatch skipped — worktree ${fixTree} not clean (or unreadable)`,
      );
    } else {
      // Clean tree. Check committed work before declaring "no fix".
      let committedCount: number | undefined;
      if (branchName) {
        const execFn = ctx.verifyExecFn ?? execp;
        committedCount = await countCommittedAhead(execFn, fixTree, branchName);
      }
      if (committedCount !== undefined && committedCount > 0) {
        // The fixer committed its work — NOT a no-diff shape. The
        // re-dispatch must not claim "no changes" when a committed fix
        // exists.
        trace(
          `work-driver: lens-fix re-dispatch skipped — worktree ${fixTree} has ${committedCount} committed fix(es) ahead of ${branchName}`,
        );
      } else {
        const evidence = branchName
          ? noDiffEvidence(fixTree, branchName, committedCount ?? null)
          : `no committed fix: no branch name recorded; worktree ${fixTree} has a clean working tree`;
        trace(`work-driver: lens-fix re-dispatch — no committed fix in ${fixTree}`);
        next = appendEvent(next, {
          kind: "lens-fix-empty-resend",
          at: Date.now(),
          jobId: makeRunId(),
          round: state.pipelineState.reviewRound,
          worktree: fixTree,
          evidence,
        });
      }
    }
  }
  const isResend = next !== state;
  const prompt = isResend
    ? [
        `RE-DISPATCH — the previous lens-fix dispatch produced no committed fix: no commits ahead of the feature branch in the lens-fix worktree ${JSON.stringify(fixTree)}.`,
        `Either the findings are already resolved in the committed diff (in which case say so with \`nothing-to-fix: <one-line reason>\` and make no changes), or the previous attempt left uncommitted work in that tree that it never committed. Inspect the tree — \`git -C ${fixTree} status\` — and commit any uncommitted fix work there: \`git add -A\` followed by \`git commit -m "<type>(scope): concise subject"\`. Do NOT push.`,
        "",
        "Findings (JSON-encoded array of {path, line, severity, title, suggestion}):",
        "```json",
        findings,
        "```",
        scratchHygieneSection(scratchDir(ctx.repoRoot, ctx.issue)),
      ].join("\n")
    : inlineLensFixPrompt(findings, scratchDir(ctx.repoRoot, ctx.issue));

  // #981 (task-b) — reposition the lens-fix worktree to the branch's
  // current tip BEFORE the fix dispatch. The worktree was created at the
  // branch's HEAD when the cycle started, but the branch may have advanced
  // since (a previous lens-fix round cherry-picked a fix). Without
  // repositioning, a round-2+ fixer sees a stale snapshot and produces a
  // divergent fix that does not integrate cleanly (the #978 shape).
  //
  // Unlike task-a's best-effort reposition, this guard is a GATE: the
  // fixer is dispatched ONLY when the worktree is verified at the branch
  // tip (`already-at-tip` / `repositioned`). A dirty tree, a tree holding
  // unlanded round-1 work, or a diverged tree parks the cycle (a
  // `lens-fix-reposition` cap-hit) — dispatching a fix onto any of those
  // bases would build on code the branch does not have.
  if (branchName && fixTree !== ctx.repoRoot) {
    // `tree !== ctx.repoRoot`: legacy state without worktrees falls back to
    // repoRoot; the reposition gate only makes sense for a separate worktree.
    const execFn: ExecFn = ctx.verifyExecFn ?? execp;
    const issueTitle = await cachedIssueTitle(state);
    const rep = await repositionLensFixWorktree(
      execFn,
      fixTree,
      branchName,
      [ctx.issue],
      issueTitle,
    );
    if (rep.kind === "already-at-tip" || rep.kind === "repositioned") {
      trace(
        `work-driver: lens-fix reposition ${rep.kind}${rep.kind === "repositioned" && rep.movedByPatchEquivalence ? " (movedByPatchEquivalence)" : ""} for ${fixTree} (branch ${branchName}) — dispatching fixer onto the verified tip`,
      );
    } else {
      // Park: the base is not trustworthy. Build the cap-hit (routed to
      // `handoff` by nextStep) and return WITHOUT dispatching the fixer.
      return parkLensFixReposition(ctx, state, now, fixTree, rep);
    }
  }

  return runSingleDispatch(
    ctx,
    next,
    "lens-fix",
    "developer",
    `developer:lens-fix-${state.pipelineState.reviewRound}`,
    now,
    () => prompt,
    // Fix the code where the code IS. This dispatch carried no cwd, so the
    // child edited repoRoot while `integrateLensFix` staged from the worktree
    // nobody had touched — `stagePorcelainPaths` returned 0 and the loop
    // `continue`d, so the fix was silently dropped and the next lens round
    // re-flagged the same findings at escalating severity until the cap.
    //
    // Observed on lantern #663: the pushed commit had deleted 1007 lines of
    // src/config/mod.rs, breaking the build. The lens-fix developer restored it
    // correctly — 1174 lines, staged — and none of it was ever committed.
    //
    // The same worktree the review itself read, so the fix lands against the
    // tree the findings describe. One worktree holds every workstream's
    // consolidated work, so there is no N>1 partition to make here.
    { cwd: lensWorktree(ctx, state) },
  );
}

/**
 * The tree the lens gate works in. #492 — exported so the adversarial gate's
 * lens-fix integration path names the SAME tree. Falls back to repoRoot.
 */
export function lensWorktree(ctx: CycleContext, state: WorkState): string {
  const wt = state.pipelineState.worktrees ?? {};
  return wt.default ?? wt[Object.keys(wt)[0] ?? ""] ?? ctx.repoRoot;
}
