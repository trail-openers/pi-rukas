/**
 * work-driver-pr-gone — the cycle's pull request changed under it.
 *
 * After commit-pr the driver keeps working on the PR it opened — the six-pass
 * review, the lens-fix, the push that lands the fix, CI — and none of those
 * steps used to look at the PR again. When a person merged or closed it
 * meanwhile, the cycle went on to fix the merged branch, pushed onto it (or
 * was refused `non-fast-forward`), and the review's residual findings were
 * posted nowhere: the disclosure looked the PR up by branch with
 * `state: open`, and its failure note was read only by the hand-run tool.
 *
 * `endIfPrGone` reads the recorded PR (`recordedPrState`, the same read the
 * second commit-pr uses) before each of those steps:
 *  - MERGED → the cycle ends `merged`, saying a person merged it during
 *    review. The driver merged nothing, so no merge-authority check applies,
 *    and nothing further is pushed.
 *  - CLOSED → parks with the `[pr-not-open]` marker, as commit-pr does.
 *  - anything unreadable → the step runs as before. A cycle is never ended
 *    on a guess.
 *
 * `recordResidualsPost` keeps a failed disclosure: it is posted to the issue
 * instead and recorded as an event either way.
 */

import { execp } from "./lens-exec.ts";
import type { LensReviewSummary } from "./lens-review-format.ts";
import { trace } from "./trace.ts";
import { recordedPrState } from "./work-driver-commit-reentry.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { releaseClaim } from "./work-driver-path-claims.ts";
import { PR_NOT_OPEN_MARKER } from "./workflow-state-cap.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * The state the cycle ends in when its PR is no longer open, or `undefined`
 * when the step should run: no PR recorded yet, the PR is open, or its state
 * could not be read.
 */
export async function endIfPrGone(
  ctx: DriverContext,
  state: WorkState,
  step: WorkStep,
): Promise<WorkState | undefined> {
  const ps = state.pipelineState;
  if (ps.prNumber === undefined || !ps.branchName) return undefined;
  const execFn = ctx.verifyExecFn ?? execp;
  const prState = await recordedPrState(ctx, execFn, ps.prNumber, ps.branchName);
  if (prState === "MERGED") return mergedDuringReview(ctx, state, ps.prNumber, step);
  if (prState === "CLOSED") return closedDuringReview(state, ps.prNumber, ps.branchName, step);
  return undefined;
}

async function mergedDuringReview(
  ctx: DriverContext,
  state: WorkState,
  prNumber: number,
  step: WorkStep,
): Promise<WorkState> {
  trace(`work-driver: PR #${prNumber} was merged by someone else before ${step} — cycle ends`);
  try {
    await releaseClaim(ctx.repoRoot, ctx.issue);
  } catch {
    /* best-effort, as on the driver's own merge */
  }
  return appendEvent(
    {
      ...state,
      pipelineState: { ...state.pipelineState, currentStep: "merged", status: "merged" },
    },
    {
      kind: "plumb-report",
      at: Date.now(),
      step,
      role: "driver",
      body: `PR #${prNumber} was merged by someone else before the ${step} step ran — the driver did not merge it, did not run ${step}, and pushed nothing further to ${state.pipelineState.branchName}. Anything not yet pushed stays in the cycle's worktree(s).`,
    },
    { kind: "merged", at: Date.now(), prNumber, mergedByOtherDuring: step },
  );
}

function closedDuringReview(
  state: WorkState,
  prNumber: number,
  branchName: string,
  step: WorkStep,
): WorkState {
  const reason = `PR #${prNumber} is CLOSED without a merge, not OPEN — the ${step} step was not run and nothing was pushed to ${branchName}. The cycle's work is on that branch and in its worktree(s).`;
  return appendEvent(
    {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        verifyEvidence: {
          step,
          failures: [`${PR_NOT_OPEN_MARKER} ${reason}`],
          at: Date.now(),
          origin: "pr-not-open",
        },
      },
    },
    { kind: "plumb-report", at: Date.now(), step, role: "driver", body: reason },
    {
      kind: "cap-hit",
      at: Date.now(),
      cap: `verify-failed:${step}`,
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
    },
  );
}

/**
 * The lens review's residual-findings disclosure did not reach the PR
 * (`summary.note` carries why). Post the findings to the issue instead and
 * record the failure. The issue copy carries no merge-guard marker: the
 * marker only means something on the PR the guard reads.
 */
export async function recordResidualsPost(
  ctx: DriverContext,
  state: WorkState,
  summary: LensReviewSummary,
  round: number,
): Promise<WorkState> {
  if (summary.verdict !== "ISSUES_FOUND" || !summary.note || summary.noReview) return state;
  const prNumber = state.pipelineState.prNumber;
  const body = [
    "## Six-pass review — residual findings (posted to the issue)",
    "",
    `Round ${round} found these, and posting them to ${prNumber ? `PR #${prNumber}` : "the pull request"} failed: ${summary.note}`,
    "",
    ...summary.findings.map(
      (f) => `- [${f.severity}] ${f.path}:${f.line ?? "?"} — ${f.title} (${f.lens})`,
    ),
    "",
  ].join("\n");
  let issueFallback: "posted" | "failed" = "failed";
  let detail: string | undefined;
  try {
    const forge = await forgeForCycle(ctx, ctx.verifyExecFn ?? execp);
    if (!forge) throw new Error("the repo's forge could not be determined");
    detail = (await forge.issueComment(ctx.issue, body)).trim() || undefined;
    issueFallback = "posted";
  } catch (err) {
    detail = (err as Error).message?.slice(0, 200);
    trace(`work-driver: residual findings could not be posted to issue #${ctx.issue}: ${detail}`);
  }
  return appendEvent(state, {
    kind: "lens-residuals-post-failed",
    at: Date.now(),
    round,
    ...(prNumber !== undefined ? { prNumber } : {}),
    reason: summary.note.slice(0, 500),
    issueFallback,
    ...(detail ? { detail } : {}),
  });
}
