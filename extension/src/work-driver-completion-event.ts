/**
 * work-driver-completion-event — buildCompletionEvent: the
 * DispatchResult → WorkEvent mapper shared by every single-dispatch
 * step. Split out of work-driver-merged.ts (AGENTS.md §12 file-size
 * limit; the file sat at 531 lines after the #543 F4(j) evidence
 * threading landed).
 *
 * The structured kill-cause (#296; #543 adds loop/token-budget) wins
 * over everything: a child pi-ensemble itself killed is OUR failure,
 * never a provider failure. The errorTail names the trigger + the
 * override knob for every cause: wall-clock ms for
 * timeout/inactivity, the streak evidence for loop, the budget + used
 * counts for token-budget.
 */

import path from "node:path";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { parseAbort } from "./work-driver-diff.ts";
import { withUsage } from "./workflow-state-events-usage.ts";
import { type WorkStep, type appendEvent, writeDispatchArtifact } from "./workflow-state.ts";

/**
 * Threshold above which a dispatch's text payload moves to a claim-check
 * artifact file under `.pi/work-state/<issue>/<id>.txt` instead of being
 * inlined into the event-log entry. Keeps state file scans fast (the file
 * is parsed on every driver wake).
 */
const ARTIFACT_THRESHOLD_BYTES = 4_000;

/** #543 — env knob named in a self-kill's errorTail (loop/token name the cap knobs). */
export function overrideEnvForKillCause(
  killCause: NonNullable<DispatchResult["killCause"]>,
): string {
  switch (killCause) {
    case "timeout":
      return "PI_ENSEMBLE_SPAWN_TIMEOUT_MS";
    case "loop":
    case "token-budget":
      return "PI_ENSEMBLE_DISPATCH_CAPS + PI_ENSEMBLE_CAP_KILL_GRACE_MS";
    case "inactivity":
    case "abort":
      return "PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS";
  }
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

  if (result.killCause) {
    let detail: string;
    if (result.killCause === "abort") {
      detail = "[pi-ensemble] cancelled (abort signal)";
    } else if (result.killCause === "loop") {
      const ev = result.loopEvidence;
      const what = ev
        ? `${ev.tool} × ${ev.count} (normalised args)`
        : "the same tool call after normalisation";
      detail =
        `[pi-ensemble] killed on loop — it kept re-issuing ${what}` +
        ` (override: ${overrideEnvForKillCause(result.killCause)})`;
    } else if (result.killCause === "token-budget") {
      const tb = result.tokenBudget;
      const budgetClause = tb
        ? `${Math.round(tb.used).toLocaleString()} of ${Math.round(tb.budget).toLocaleString()} tokens`
        : "its cumulative token budget";
      detail =
        `[pi-ensemble] killed on token-budget — ${budgetClause}` +
        ` (override: ${overrideEnvForKillCause(result.killCause)})`;
    } else {
      detail =
        `[pi-ensemble] killed after ${result.killBudgetMs}ms ${result.killCause}` +
        ` (override: ${overrideEnvForKillCause(result.killCause)})`;
    }
    // Attribute the silence, not just the budget. `linesSeen: 0` means the
    // child never spoke — a provider stall or auth failure, not a hang.
    const la = result.lastActivity;
    const attribution = la
      ? ` · last output: ${la.kind} ${Math.round(la.agoMs / 1000)}s before the kill, after ${la.linesSeen} line(s)`
      : "";
    return withUsage(
      {
        kind: "dispatch-failed",
        step,
        role,
        jobId,
        label,
        ms: result.ms,
        at,
        exitCode: result.exitCode ?? null,
        errorTail: `${detail}${attribution}`,
        killCause: result.killCause,
        // #543 — carry the structured trigger evidence on the event so the
        // step router can persist it on `pipelineState.capEvidence` when it
        // emits the cap-hit. Absent for the four non-cap causes (timeout /
        // inactivity / abort / the no-cause fallback).
        ...(result.killCause === "loop" && result.loopEvidence
          ? { loopEvidence: result.loopEvidence }
          : {}),
        ...(result.killCause === "token-budget" && result.tokenBudget
          ? { tokenBudget: result.tokenBudget }
          : {}),
      },
      result.usage,
    );
  }
  if (result.errorStop) {
    return withUsage(
      {
        kind: "dispatch-failed-provider",
        step,
        role,
        jobId,
        label,
        ms: result.ms,
        at,
        providerMessage: result.errorStop.message,
        transcriptPath: result.transcriptPath,
      },
      result.usage,
    );
  }
  if (!result.ok) {
    return withUsage(
      {
        kind: "dispatch-failed",
        step,
        role,
        jobId,
        label,
        ms: result.ms,
        at,
        exitCode: result.exitCode ?? null,
        errorTail: result.text?.slice(-200),
      },
      result.usage,
    );
  }

  // ABORT detection (PR2): the subagent's PROCESS exited 0 but it
  // refused the requested action (dirty worktree, --ff-only refusal, etc).
  // Without this check, branch step's "**ABORT: Working tree is not
  // clean**" on issue #553 was recorded as success and the driver
  // continued develop on main with 41 untracked files. Treat the abort
  // as dispatch-failed so the driver's existing fail-path halts cleanly.
  const abortLine = parseAbort(result.text);
  if (abortLine) {
    return withUsage(
      {
        kind: "dispatch-failed",
        step,
        role,
        jobId,
        label,
        ms: result.ms,
        at,
        exitCode: result.exitCode ?? null,
        errorTail: abortLine.slice(0, 500),
      },
      result.usage,
    );
  }

  // Successful completion. Spill large text bodies to a claim-check
  // artifact under .pi/work-state/<issue>/<jobId>.txt so the state file
  // stays small.
  const text = result.text ?? "";
  let summary: string | undefined;
  let artifactPath: string | undefined;
  if (Buffer.byteLength(text, "utf8") > ARTIFACT_THRESHOLD_BYTES) {
    try {
      artifactPath = await writeDispatchArtifact(ctx.repoRoot, ctx.issue, jobId, text);
    } catch (err) {
      trace(
        `work-driver: artifact write failed for ${jobId}: ${(err as Error).message?.slice(0, 120)}`,
      );
    }
  } else {
    summary = text;
  }
  return withUsage(
    {
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
    },
    result.usage,
  );
}
