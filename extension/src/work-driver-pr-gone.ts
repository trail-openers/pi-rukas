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

import { neutraliseMarkdownField } from "./comment-evidence.ts";
import { execp } from "./exec.ts";
import { severityLabel } from "./lens-residuals.ts";
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
 * What the gate decided. `ended` is set when the cycle must stop; `state` is
 * what the step runs on (it carries a plumb note when the PR state could not
 * be read).
 */
export type PrGate = { ended?: WorkState; state: WorkState };

/** Backoff before each re-read of an unreadable PR state (two retries). */
const PR_STATE_RETRY_DELAYS_MS = [500, 1500];

/**
 * Cycles whose PR state has already been found unreadable. Once a cycle has
 * seen it, later gates make one read each (a merge is still caught) with no
 * backoff and no second plumb note — so an unreadable forge costs the
 * retries and the note once per cycle, not once per gated step.
 */
const unreadableCycles = new WeakSet<DriverContext>();

export async function endIfPrGone(
  ctx: DriverContext,
  state: WorkState,
  step: WorkStep,
): Promise<PrGate> {
  const ps = state.pipelineState;
  // No forge configured: there is no PR to read, so no lookup, no retries, no note.
  if (ps.prNumber === undefined || !ps.branchName) return { state };
  if (process.env.PI_ENSEMBLE_FORGE === "none") return { state };
  const execFn = ctx.verifyExecFn ?? execp;
  const seen = unreadableCycles.has(ctx);
  const read = await readPrState(ctx, execFn, ps.prNumber, ps.branchName, !seen);
  if (read.prState === "MERGED") {
    return { state, ended: await mergedDuringReview(ctx, state, ps.prNumber, step) };
  }
  if (read.prState === "CLOSED") {
    return { state, ended: closedDuringReview(state, ps.prNumber, ps.branchName, step) };
  }
  if (read.prState === undefined && !seen) {
    unreadableCycles.add(ctx);
    return { state: unreadablePrNote(state, ps.prNumber, step, read) };
  }
  return { state };
}

type PrRead = {
  prState?: "OPEN" | "MERGED" | "CLOSED";
  attempts: number;
  /** The last thrown `gh` error, when the read itself failed. */
  error?: string;
};

/** `recordedPrState` folds a thrown `gh` error into `undefined`, so retry on that. */
async function readPrState(
  ctx: DriverContext,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  prNumber: number,
  branchName: string,
  retry: boolean,
): Promise<PrRead> {
  let error: string | undefined;
  const readOnce = () =>
    recordedPrState(ctx, execFn, prNumber, branchName, (m) => {
      error = m;
    });
  let prState = await readOnce();
  let attempts = 1;
  for (const delay of retry ? PR_STATE_RETRY_DELAYS_MS : []) {
    if (prState !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    prState = await readOnce();
    attempts++;
  }
  return { prState, attempts, error };
}

/**
 * The PR state stayed unreadable through every attempt: the step runs anyway
 * (a cycle is never ended on a guess), but the operator is told the check did
 * not run, in the state file's plumbReports the handoff renders. The report's
 * role is `pr-gate`, so readers can tell it from an integration failure.
 */
function unreadablePrNote(
  state: WorkState,
  prNumber: number,
  step: WorkStep,
  read: PrRead,
): WorkState {
  const last = read.error ? `last error: ${read.error}` : "the PR is not on this branch";
  const body = `PR #${prNumber}'s state could not be read before the ${step} step (${read.attempts} attempt(s); ${last}), so the merged/closed check did not run and the step ran anyway. If the PR was merged or closed meanwhile, the step's push is refused or lands on a merged branch — check the PR.`;
  trace(`work-driver: ${body}`);
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        { step, role: "pr-gate", body, at: Date.now() },
      ],
    },
  };
}

// `mergedDuringReview` shares status "merged" with the driver's own merge. The
// consumers that key on it were checked and none counts the human merge as the
// driver's: terminal delivery and work-status render mergedByOtherDuring ("by
// someone else during <step>"); work-queue / work-queue-summary record outcome
// "merged", which is true of the PR; work-notify never notifies a merged group
// (the person who merged it knows); headless exit-code 0 means the work landed;
// the resume guard (work-driver.ts) refuses any non-running status without
// --restart; the worktree sweep deletes only work proven on the remote.
async function mergedDuringReview(
  ctx: DriverContext,
  state: WorkState,
  prNumber: number,
  step: WorkStep,
): Promise<WorkState> {
  trace(`work-driver: PR #${prNumber} was merged by someone else before ${step} — cycle ends`);
  try {
    await releaseClaim(ctx.repoRoot, ctx.issue);
  } catch (err) {
    // best-effort, as on the driver's own merge — but traced, not invisible
    trace(`work-driver: releaseClaim after the human merge failed: ${String(err)}`);
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
      cap: `pr-not-open:${step}`, // #1349 — nothing was judged
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
  // The findings are the lens's words, and this body is posted to the forge as
  // markdown: severity, path and title all go through the markdown-post
  // neutraliser (see `neutraliseMarkdownField`) so a stored title cannot carry
  // an HTML comment or a link into the issue.
  const findingLines = summary.findings.map(
    (f) =>
      `- [${severityLabel(f.severity)}] ${neutraliseMarkdownField(`${f.path}:${f.line ?? "?"}`)} — ${neutraliseMarkdownField(f.title)} (${neutraliseMarkdownField(f.lens)})`,
  );
  const body = [
    "## Six-pass review — residual findings (posted to the issue)",
    "",
    `Round ${round} found these, and posting them to ${prNumber ? `PR #${prNumber}` : "the pull request"} failed: ${summary.note}`,
    "",
    ...findingLines,
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
    detail = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    trace(`work-driver: residual findings could not be posted to issue #${ctx.issue}: ${detail}`);
  }
  const next = appendEvent(state, {
    kind: "lens-residuals-post-failed",
    at: Date.now(),
    round,
    ...(prNumber !== undefined ? { prNumber } : {}),
    reason: summary.note.slice(0, 500),
    issueFallback,
    ...(detail ? { detail } : {}),
  });
  if (issueFallback === "posted") return next;
  // Both posts failed: the findings would otherwise exist only in the event
  // log, which the handoff does not render. Keep them in plumbReports.
  const list = summary.findings.map(
    (f) =>
      `- ${neutraliseMarkdownField(`${f.path}:${f.line ?? "?"}`)} ${severityLabel(f.severity)} ${neutraliseMarkdownField(f.title)} (${neutraliseMarkdownField(f.lens)})`,
  );
  const report = {
    step: "lens-review" as const,
    role: "residuals-post",
    body: [
      `Round ${round} residual findings were not posted to ${prNumber ? `PR #${prNumber}` : "the PR"} or to issue #${ctx.issue}; kept here so the handoff shows them:`,
      ...list,
    ].join("\n"),
    at: Date.now(),
  };
  return {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      plumbReports: [...(next.pipelineState.plumbReports ?? []), report],
    },
  };
}
