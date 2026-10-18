/**
 * work-driver-lens-fix — the lens-fix step (Step 7f): the developer dispatch
 * that answers the lens findings, in the tree the review read. Split from
 * work-driver-lens.ts (500-line limit); importers take it from here.
 */

import { execp } from "./exec.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { continuedHeadMoved, headMovedCap } from "./work-driver-continue-pr-guard.ts";
import { cachedIssueTitle } from "./work-driver-integrate.ts";
import { parkLensFixOverrun, reviewFixDispatchBoundMs } from "./work-driver-lens-fix-budget.ts";
import {
  countCommittedAhead,
  countLensFixEmptyResends,
  noDiffEvidence,
} from "./work-driver-lens-fix-commit.ts";
import { repositionLensFixWorktree } from "./work-driver-lens-fix-reposition-gate.ts";
import { parkLensFixReposition } from "./work-driver-lens-fix-reposition-park.ts";
import { runSingleDispatch } from "./work-driver-merged.ts";
import { scratchHygieneSection } from "./work-driver-prompts-late.ts";
import { developTestScopeLine } from "./work-driver-verify-fast.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Step 7f — the lens-fix developer prompt.
 *
 * Lives here rather than in work-driver-prompts-late.ts because this is the
 * only module that dispatches it, and that file sits at the AGENTS.md §12
 * 500-line cap. Same reason the rest of the lens-fix step already lives here.
 */
export function inlineLensFixPrompt(findings: string, scratchDirAbs: string): string {
  return [
    "Address the six-pass review findings below against the diff currently on this worktree.",
    "",
    "  - Make the minimal change per finding. Group by file.",
    "  - Run local quality gates before declaring complete.",
    // #1156 — the same test-scope + suite-bound rule the develop prompt carries:
    // a lens-fix dispatch is a developer in the same worktree with the same
    // gates to re-run, and it historically ran the WHOLE offline suite to
    // re-check a two-line fix. Asserted in test-lens-fix-test-scope.ts.
    `  - ${developTestScopeLine()}`,
    "  - Do NOT touch unrelated code.",
    // #543 F5 — same seam-commit clause as the develop prompt: the driver's
    // cap-checkpoint (F5(2)) commits the worktree at natural seams, so a
    // cap kill never leaves only a failure message. Read-only roles get no
    // such line; this one is the developer (write-gated off, worktree cwd).
    // #621 — same explicit git command + gate-requirement wording as
    // inlineDevelopPrompt: the lens-fix worktree is the same tree the
    // develop gate (and later the adversarial diff) reads, so committed
    // work is what the downstream steps expect.
    // #1078 — commit subject follows the project's convention (same
    // softening as the develop prompt).
    "  - Commit your work in the worktree at natural seams (a clean build, a passing test suite): run `git add -A` followed by `git commit -m \"<concise subject — follow the project's commit convention from AGENTS.md, or <type>(scope): description>\"`. The driver's gate REJECTS uncommitted-only work — no commit ahead of base SHA means the step fails. Do NOT push — the driver owns the branch.",
    "",
    "Findings (JSON-encoded array of {path, line, severity, title, suggestion}):",
    "```json",
    findings,
    "```",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

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
  // #1416 — the 90-minute review-loop budget used to be PRINTED (the widget's
  // `cap 100m11s/90m`) and never enforced: the only check ran after a review
  // had returned, so a fixer already past its budget was awaited to completion.
  // Checked here, at the dispatch boundary: already over → park without
  // dispatching; still under → the fixer is bound to what the budget leaves.
  const overrun = await parkLensFixOverrun(ctx, state, now);
  if (overrun !== state) return overrun;
  const dispatchBoundMs = reviewFixDispatchBoundMs(state, "lens-fix", now);
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
        // #1156 — the re-dispatch is the same developer in the same worktree
        // with the same gates to re-run, so it carries the same test-scope +
        // suite-bound rule as `inlineLensFixPrompt`. This branch is a separate
        // inline array built alongside that function, which is exactly where
        // the rule got dropped once.
        `  - ${developTestScopeLine()}`,
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
    // #1468 — the reposition fast-forwards onto origin's tip: never onto a foreign push.
    const moved = await continuedHeadMoved(execFn, ctx.repoRoot, state.pipelineState);
    if (moved) return headMovedCap(state, moved, "lens-fix");
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
    {
      cwd: lensWorktree(ctx, state),
      ...(dispatchBoundMs !== undefined ? { timeoutMs: dispatchBoundMs } : {}),
    },
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
