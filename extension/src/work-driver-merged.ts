/**
 * work-driver-merged — Step 9 (merged) handler + the generic single-
 * dispatch helper + merge-reply parsing + dispatch-completion event
 * builder.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene).
 * `buildCompletionEvent` is the shared DispatchResult → WorkEvent mapper
 * every step handler calls after a dispatch. `runSingleDispatch` is the
 * generic "append step-started → dispatch one subagent → append
 * completion event" helper every simple step body (branch, lens-fix,
 * step-back, ci, merged) is built on. `parseMergeCommit` + `runMerged`
 * are the Step 9 pair. All four land together as the "merged step" leaf
 * cluster since runMerged is itself just a runSingleDispatch call plus
 * parseMergeCommit.
 */

import path from "node:path";
import { dispatchCore } from "./dispatch.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { parseAbort } from "./work-driver-diff.ts";
import { inlineMergePrompt } from "./work-driver-prompts-late.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import {
  type WorkState,
  type WorkStep,
  appendEvent,
  writeDispatchArtifact,
} from "./workflow-state.ts";

/**
 * Threshold above which a dispatch's text payload moves to a claim-check
 * artifact file under `.pi/work-state/<issue>/<id>.txt` instead of being
 * inlined into the event-log entry. Keeps state file scans fast (the file
 * is parsed on every driver wake).
 */
const ARTIFACT_THRESHOLD_BYTES = 4_000;

/**
 * PR10 — Parse a `merge-commit: <sha>` marker line from ops's merge reply.
 * Lenient: accepts surrounding markdown (`**merge-commit:**`), backticks,
 * and the 7+ hex-char SHA shape `gh pr merge` prints. Returns undefined
 * when no marker is present (the merge still succeeded; we just lost the
 * SHA for the merged event payload).
 */
export function parseMergeCommit(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // Lenient: anchor on `merge-commit`, then allow ANY non-hex characters
  // (markdown emphasis, colons, backticks, whitespace) up to the SHA.
  // The SHA itself is the only required structural element. Per-line
  // (multiline mode) so a multi-line ops reply can have the marker
  // anywhere on its own line.
  const m = text.match(/^[ \t]*[*_`]*\s*merge-commit\b[^0-9a-f\n]*([0-9a-f]{7,40})[^0-9a-f\n]*$/im);
  return m?.[1];
}

/**
 * Build a dispatch-completed (or dispatch-failed-provider / dispatch-
 * failed) event from a DispatchResult. Handles the claim-check threshold
 * for large summaries.
 */
export async function buildCompletionEvent(
  ctx: DriverContext,
  step: WorkStep,
  role: string,
  label: string,
  result: DispatchResult,
): Promise<
  Extract<
    Parameters<typeof appendEvent>[1],
    {
      kind: "dispatch-completed" | "dispatch-failed-provider" | "dispatch-failed";
    }
  >
> {
  const at = Date.now();
  const jobId = result.transcriptPath ? path.basename(result.transcriptPath, ".json") : "unknown";

  // Structured kill-cause (#296) wins over everything: a child pi-ensemble
  // itself killed (wall-clock cap / inactivity watchdog / abort) is OUR
  // failure, never a provider failure — even if the dying child also
  // flushed an error-stop message. The errorTail names the budget and the
  // override knob so the operator-facing explanation is accurate.
  if (result.killCause) {
    const roleEnv = `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_${role.toUpperCase().replaceAll("-", "_")}`;
    const detail =
      result.killCause === "abort"
        ? "[pi-ensemble] cancelled (abort signal)"
        : `[pi-ensemble] killed after ${result.killBudgetMs}ms ${result.killCause}` +
          ` (override: ${result.killCause === "timeout" ? roleEnv : "PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS"})`;
    return {
      kind: "dispatch-failed",
      step,
      role,
      jobId,
      label,
      ms: result.ms,
      at,
      exitCode: result.exitCode ?? null,
      errorTail: detail,
      killCause: result.killCause,
    };
  }
  if (result.errorStop) {
    return {
      kind: "dispatch-failed-provider",
      step,
      role,
      jobId,
      label,
      ms: result.ms,
      at,
      providerMessage: result.errorStop.message,
      transcriptPath: result.transcriptPath,
    };
  }
  if (!result.ok) {
    return {
      kind: "dispatch-failed",
      step,
      role,
      jobId,
      label,
      ms: result.ms,
      at,
      exitCode: result.exitCode ?? null,
      errorTail: result.text?.slice(-200),
    };
  }

  // ABORT detection (PR2): the subagent's PROCESS exited 0 but it
  // refused the requested action (dirty worktree, --ff-only refusal, etc).
  // Without this check, branch step's "**ABORT: Working tree is not
  // clean**" on issue #553 was recorded as success and the driver
  // continued develop on main with 41 untracked files. Treat the abort
  // as dispatch-failed so the driver's existing fail-path halts cleanly.
  const abortLine = parseAbort(result.text);
  if (abortLine) {
    return {
      kind: "dispatch-failed",
      step,
      role,
      jobId,
      label,
      ms: result.ms,
      at,
      exitCode: result.exitCode ?? null,
      errorTail: abortLine.slice(0, 500),
    };
  }

  // Successful completion. Spill large text bodies to a claim-check
  // artifact under .pi/work-state/<issue>/<jobId>.txt so the state file
  // stays small.
  const text = result.text ?? "";
  let summary: string | undefined;
  let artifactPath: string | undefined;
  if (Buffer.byteLength(text, "utf8") > ARTIFACT_THRESHOLD_BYTES) {
    artifactPath = await writeDispatchArtifact(ctx.repoRoot, ctx.issue, jobId, text);
  } else {
    summary = text;
  }
  return {
    kind: "dispatch-completed",
    step,
    role,
    jobId,
    label,
    ok: true,
    ms: result.ms,
    at,
    transcriptPath: result.transcriptPath,
    summary,
    artifactPath,
  };
}

/**
 * Generic single-dispatch helper used by every step body whose shape is
 * "append step-started → dispatch one subagent → append completion event".
 * Steps that need to emit additional events (adversarial verdicts, lens
 * verdicts, CI status) implement their own runX and call dispatchCore
 * directly.
 */
export async function runSingleDispatch(
  ctx: DriverContext,
  state: WorkState,
  step: WorkStep,
  role: string,
  label: string,
  now: number,
  buildPrompt: () => string,
  opts?: { timeoutMs?: number },
): Promise<WorkState> {
  const next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: step } },
    { kind: "step-started", step, at: now },
  );
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  let result: DispatchResult;
  try {
    // PR15 — per-call timeout override (routed through dispatchCore's
    // existing timeoutMs support that PR5 added for the 3-min handoff-ops
    // path). runCi uses this to lift the 10-min ops default up to 30 min
    // (env-overridable) since `gh run watch` blocks until CI completes
    // and CI runs regularly exceed 10 min. Empirical: 3× ops-CI-poll
    // timeouts this session before PR15.
    result = await dispatch(
      ctx.pi,
      { role, prompt: buildPrompt() },
      { label, timeoutMs: opts?.timeoutMs },
    );
  } catch (err) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step,
      role,
      jobId: "unknown",
      label,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }
  const event = await buildCompletionEvent(ctx, step, role, label, result);
  return appendEvent(next, event);
}

/**
 * Step 9 — Merge the PR. PR10: was a 0ms state mutation pre-fix; now
 * actually dispatches ops to run `gh pr merge` per project policy.
 *
 * Empirical bug fixed: pre-PR10 the driver reported "MERGED ✓" while
 * the GitHub PR sat OPEN (live evidence /work 561 + /work 562 on
 * lantern). The doctrine in pi-prompts/work.md:277 ("On green CI +
 * APPROVED review: merge per project merge policy") declared the
 * intent; nothing executed it. runMerged now closes that gap.
 *
 * On dispatch failure: STEP_FAILURE_POLICY[merged] is HALT (changed
 * from DEGRADED_OK), so the post-step dispatch-failed router (PR5)
 * intercepts → cap-hit 'step-failed:merged' → handoff. Operator
 * merges manually with the recovery command in the handoff body.
 *
 * On dispatch success: capture the merge-commit SHA (if ops emits the
 * marker line); flip status='merged'.
 */
export async function runMerged(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const prNumber = state.pipelineState.prNumber ?? 0;
  const issues = activeIssuesOf(state);
  const next = await runSingleDispatch(ctx, state, "merged", "ops", "ops:merge", now, () =>
    inlineMergePrompt(issues, prNumber, scratchDir(ctx.repoRoot, state.issue)),
  );
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const mergeCommit = parseMergeCommit(last.summary);
  return {
    ...next,
    pipelineState: { ...next.pipelineState, currentStep: "merged", status: "merged" },
    eventLog: [...next.eventLog, { kind: "merged", at: Date.now(), prNumber, mergeCommit }],
  };
}
