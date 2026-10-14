/**
 * work-driver-draft-pr — the cycle's PR is a draft until the driver's review
 * is done (#1292).
 *
 * commit-pr opens the PR before the six-pass review, and review + fix take
 * hours. For that whole window GitHub showed an ordinary mergeable PR, and
 * people merged five of nine cycle PRs on one repo mid-review, stranding the
 * findings. A draft cannot be merged with the normal button or `gh pr merge`.
 *
 * Lifecycle (`pipelineState.prDraft`):
 *   - commit-pr opens the PR with `--draft` when `draftPrEnabled` → `draft`.
 *   - entering `ci` (the review produced its verdict), entering `merged`, and
 *     a handoff after a concluded review mark it ready → `ready`. Every
 *     attempt that fails is retried; exhausted attempts → `ready-failed`
 *     with the error, which the next mark point retries and the handoff
 *     comment reports — a failure is never dropped.
 *   - a handoff that cuts the review short (a park or halt before a verdict,
 *     or during a fix round) leaves it a draft, and the handoff comment says
 *     so (`draftPrHandoffLines`).
 *
 * A draft is still state OPEN (GitHub) / opened (GitLab), so the re-entry
 * guard and the identity gate accept it unchanged.
 */

import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { handoffPostBackoffMs, handoffPostRetryEnabled } from "./work-driver-handoff-post-retry.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** Total `pr ready` attempts per mark point (initial + 2 retries). */
const MAX_READY_ATTEMPTS = 3;

/**
 * `PI_ENSEMBLE_DRAFT_PR=1` / `=0` forces the setting; unset, it is on for a
 * headless `/work` (nobody is watching the review window) and off otherwise.
 */
export function draftPrEnabled(ctx: Pick<DriverContext, "headless">): boolean {
  const v = process.env.PI_ENSEMBLE_DRAFT_PR;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return ctx.headless === true;
}

/** Steps that change or re-review the code: a review is not done while one follows the verdict. */
const REVIEW_LOOP_STEPS = new Set([
  "develop",
  "adversarial",
  "commit-pr",
  "lens-fix",
  "lens-review",
]);

/**
 * Did the latest review produce a verdict that nothing has superseded? True
 * when a lens verdict (approved, issues found — CRITICAL included — or an
 * empty diff) is on the log and no review-loop step started after it. Caps,
 * step-back, ci and merged may follow; a fix round or a re-review may not.
 */
export function reviewConcluded(eventLog: readonly WorkEvent[]): boolean {
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const e = eventLog[i];
    if (!e) continue;
    if (
      e.kind === "lens-approved" ||
      e.kind === "lens-issues-found" ||
      e.kind === "lens-skipped-empty-diff"
    ) {
      return true;
    }
    if (e.kind === "step-started" && REVIEW_LOOP_STEPS.has(e.step)) return false;
  }
  return false;
}

/**
 * Mark the cycle's draft PR ready, retrying a failed call. A no-op unless the
 * PR was opened as a draft and is not ready yet. Never throws: the outcome is
 * recorded on `prDraft` for the handoff to report.
 */
export async function markDraftPrReady(
  ctx: DriverContext,
  state: WorkState,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<WorkState> {
  const ps = state.pipelineState;
  const prNumber = ps.prNumber;
  if (prNumber === undefined || !ps.prDraft || ps.prDraft.status === "ready") return state;
  let error = "the forge for this repo could not be determined";
  const forge = ctx.forge ?? (await forgeForCycle(ctx, ctx.verifyExecFn ?? execp));
  const attempts = forge ? (handoffPostRetryEnabled() ? MAX_READY_ATTEMPTS : 1) : 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await forge?.prReady(prNumber);
      trace(`work-driver: PR #${prNumber} marked ready for review (draft → ready)`);
      return withPrDraft(state, { status: "ready" });
    } catch (err) {
      const e = err as Error & { stderr?: string };
      error = (e.stderr || e.message || String(err)).toString().trim().slice(0, 300);
      trace(`work-driver: pr ready #${prNumber} failed (attempt ${attempt}/${attempts}): ${error}`);
    }
    if (attempt < attempts) await sleep(handoffPostBackoffMs() * attempt);
  }
  return withPrDraft(state, { status: "ready-failed", error });
}

/**
 * The handoff's decision: a review that concluded is marked ready whatever its
 * verdict, and a ready that failed earlier is retried; a cycle that stopped
 * before its review concluded leaves the draft in place.
 */
export async function settleDraftPrAtHandoff(
  ctx: DriverContext,
  state: WorkState,
  sleep?: (ms: number) => Promise<void>,
): Promise<WorkState> {
  const draft = state.pipelineState.prDraft;
  if (!draft || draft.status === "ready") return state;
  if (draft.status === "draft" && !reviewConcluded(state.eventLog)) {
    trace("work-driver: handoff before the review concluded — PR stays a draft");
    return state;
  }
  return markDraftPrReady(ctx, state, sleep);
}

/** The handoff comment's lines about the draft (empty when there is nothing to say). */
export function draftPrHandoffLines(ps: WorkState["pipelineState"]): string[] {
  const draft = ps.prDraft;
  const pr = ps.prNumber;
  if (!draft || pr === undefined || draft.status === "ready") return [];
  if (draft.status === "draft") {
    return [
      "### Pull request is still a draft",
      "",
      `PR #${pr} was opened as a draft and stays one: the cycle stopped before the driver's review concluded, so it is not ready to merge as it stands. Mark it ready with \`gh pr ready ${pr}\` once the work is finished.`,
      "",
    ];
  }
  return [
    "### Marking the pull request ready FAILED",
    "",
    `The review is done, but \`gh pr ready ${pr}\` failed on every attempt, so PR #${pr} is still a draft. Last error: ${draft.error ?? "(none recorded)"}`,
    "",
    `Run \`gh pr ready ${pr}\` to mark it ready.`,
    "",
  ];
}

function withPrDraft(
  state: WorkState,
  prDraft: NonNullable<WorkState["pipelineState"]["prDraft"]>,
): WorkState {
  return { ...state, pipelineState: { ...state.pipelineState, prDraft } };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
