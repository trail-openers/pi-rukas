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

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { parseAbort } from "./work-driver-diff.ts";
import { readDoctrineAtBase } from "./work-driver-doctrine.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import { detectMainline, restoreCheckout } from "./work-driver-git.ts";
import { withIntegrationLock } from "./work-driver-integrate.ts";
import {
  gatherMergeEvidence,
  mergeAuthorityEnabled,
  resolveMergeAuthority,
} from "./work-driver-merge-authority.ts";
import { type MergeMethod, mechanizedMerge } from "./work-driver-merged-mechanized.ts";
import { DOCTRINE_FILES, type DoctrineDoc, judgePolicy } from "./work-driver-policy.ts";
import { inlineMergePrompt } from "./work-driver-prompts-late.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { activeIssuesOf, scratchDir, teardownWorkspaceTmp } from "./work-driver-workspace.ts";
import {
  type WorkState,
  type WorkStep,
  appendEvent,
  writeDispatchArtifact,
  writeState,
} from "./workflow-state.ts";
import { worktreePrune, worktreeRemove } from "./worktree.ts";

/**
 * Threshold above which a dispatch's text payload moves to a claim-check
 * artifact file under `.pi/work-state/<issue>/<id>.txt` instead of being
 * inlined into the event-log entry. Keeps state file scans fast (the file
 * is parsed on every driver wake).
 */
const ARTIFACT_THRESHOLD_BYTES = 4_000;

const execp = promisify(exec);

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
    const detail =
      result.killCause === "abort"
        ? "[pi-ensemble] cancelled (abort signal)"
        : `[pi-ensemble] killed after ${result.killBudgetMs}ms ${result.killCause}` +
          ` (override: ${
            result.killCause === "timeout"
              ? "PI_ENSEMBLE_SPAWN_TIMEOUT_MS"
              : "PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS"
          })`;
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
  opts?: { timeoutMs?: number; cwd?: string },
): Promise<WorkState> {
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: step } },
    { kind: "step-started", step, at: now },
  );
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  // #382 — WRITE-AHEAD. A dispatch can run for thirty minutes; before this,
  // nothing hit disk until it returned, so a crash inside that window left
  // the state file at the PREVIOUS step boundary still claiming `running`. A
  // crashed cycle was indistinguishable from a live one, forever. Persisting
  // the intent first is what makes the difference visible on resume.
  const begun = await beginDispatch(ctx.repoRoot, next, step, role, label, startedAt);
  next = begun.state;
  const jobId = begun.jobId;
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
      // `cwd` matters for any step whose work lives somewhere other than the
      // integration point. Without it `spawn.ts` falls back to the Pi process's
      // own directory, so a lens-fix developer edited repoRoot while the driver
      // staged from the worktree — see the lens-fix call site.
      { role, prompt: buildPrompt(), ...(opts?.cwd ? { cwd: opts.cwd } : {}) },
      { label, timeoutMs: opts?.timeoutMs },
    );
  } catch (err) {
    return appendEvent(clearDispatch(next, jobId), {
      kind: "dispatch-failed",
      step,
      role,
      jobId,
      label,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }
  const event = await buildCompletionEvent(ctx, step, role, label, result);
  // Clear the in-flight marker whichever way the dispatch settled — a
  // completed dispatch that still looks in-flight would make the next
  // invocation resume a step that already finished.
  return appendEvent(clearDispatch(next, jobId), event);
}

/**
 * Step 9 — Merge the PR. PR10: was a 0ms state mutation pre-fix; now
 * actually merges via mechanized merge (or LLM fallback) and restores
 * the local checkout to an up-to-date mainline.
 *
 * Mechanized path (default): derive merge method from GitHub repo
 * settings, execute `gh pr merge`, verify MERGED via `gh pr view`,
 * restore checkout. Fallback to LLM ops dispatch on any mechanized
 * failure (plumb-report emitted). Escape hatch:
 * The LLM ops dispatch remains as the fallback on mechanized failure.
 *
 * Restoration runs INSIDE runMerged, before routeStepOutcome persists
 * state. Combined with idempotent merge (already-merged tolerance), a
 * crash mid-restoration is recoverable on resume.
 *
 * On dispatch failure: STEP_FAILURE_POLICY[merged] is HALT → cap-hit
 * 'step-failed:merged' → handoff. Operator merges manually.
 */
export async function runMerged(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const prNumber = state.pipelineState.prNumber ?? 0;
  const issues = activeIssuesOf(state);
  let next: WorkState;
  let mergeMethod: MergeMethod = "squash";
  let preDispatch = state;
  let mergeSucceeded = false;

  // #380 — two independent gates, both defaulting to "no". Merging is the one
  // irreversible act in the cycle and had neither: no authority check existed
  // anywhere in src/, and the decision to merge came from a substring in an
  // ops child's reply. A cycle that reaches here has a green PR; it does NOT
  // automatically have permission to merge it.
  if (mergeAuthorityEnabled()) {
    const execFnAuth = ctx.verifyExecFn ?? execp;
    // #406 — doctrine is read at the BASE commit, never from the working tree.
    // This step runs after `commit-pr` integrated the developer's patches, so
    // an AGENTS.md read from disk here would include any grant a subagent just
    // wrote for itself. Reading at base makes such a patch inert without
    // forbidding it: honest AGENTS.md changes still ship in the PR.
    const docs: DoctrineDoc[] = [];
    for (const file of DOCTRINE_FILES) {
      const read = await readDoctrineAtBase(
        execFnAuth,
        ctx.repoRoot,
        state.pipelineState.baseSha,
        file,
      );
      if (read.text !== undefined) docs.push({ file, text: read.text });
      else if (read.reason) trace(`work-driver: merge authority — ${read.reason}`);
    }
    // #407 — the documents are read by a judge and its answer is
    // citation-verified, not matched against English regexes.
    const authority = await resolveMergeAuthority(judgePolicy(ctx.repoRoot), docs, ctx.mergeGrant);
    const evidence = authority.granted
      ? await gatherMergeEvidence(execFnAuth, ctx.repoRoot, prNumber)
      : undefined;
    if (!authority.granted || !evidence?.ok) {
      trace(
        `work-driver: merge held — authority=${authority.source}, evidence=${evidence?.reason ?? "not gathered"}`,
      );
      const held: WorkState = {
        ...state,
        pipelineState: {
          ...state.pipelineState,
          currentStep: "merged",
          mergeHold: {
            authorityGranted: authority.granted,
            authoritySource: authority.source,
            ...(authority.quote ? { authorityQuote: authority.quote } : {}),
            ...(evidence?.reason ? { evidenceReason: evidence.reason } : {}),
            ...(evidence?.inconclusive?.length ? { inconclusive: evidence.inconclusive } : {}),
          },
        },
      };
      return appendEvent(held, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "awaiting-human-merge",
        reviewRound: held.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
  }

  // Try mechanized merge first.
  const mechResult = await mechanizedMerge(ctx, state);
  if (mechResult.ok) {
    mergeMethod = mechResult.method;
    mergeSucceeded = true;
    // Mechanized merge succeeded — build the same event shapes the
    // dispatch path produces so downstream (merged event) is identical.
    // Record it; do not dispatch it. `runSingleDispatch` really spawns, and
    // `driver` is not a role — every successful mechanized merge used to throw
    // `Unknown role: driver`, become dispatch-failed, and route a merged PR to
    // handoff with teardown skipped. `work-driver-commit.ts` builds its
    // mechanized event directly for the same reason.
    next = appendEvent(
      { ...state, pipelineState: { ...state.pipelineState, currentStep: "merged" } },
      { kind: "step-started", step: "merged", at: now },
    );
    next = appendEvent(
      next,
      synthesizeDriverCompletion({
        step: "merged",
        label: "driver:merge",
        summary: `Mechanized merge: PR #${prNumber} merged via --${mergeMethod}${mechResult.notes.length > 0 ? ` Notes: ${mechResult.notes.join("; ")}` : ""}`,
        startedAt: now,
        now: Date.now(),
      }),
    );
  } else {
    // Mechanized path failed — emit plumb-report and fall back to LLM.
    preDispatch = appendEvent(state, {
      kind: "plumb-report",
      at: Date.now(),
      step: "merged",
      role: "driver",
      body: `Mechanized merge fell back to ops dispatch: ${mechResult.reason}.`,
    });
    // Always resolve the merge method for the fallback prompt.
    mergeMethod = mechResult.method ?? "squash";
    next = await runSingleDispatch(ctx, preDispatch, "merged", "ops", "ops:merge", now, () =>
      inlineMergePrompt(issues, prNumber, mergeMethod, scratchDir(ctx.repoRoot, state.issue)),
    );
  }

  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;

  // For LLM fallback path: parse merge-commit marker from ops reply.
  // Mechanized path: mergeSucceeded is already true; mergeCommit stays
  // undefined (merge SHA extraction from mechanized path is a separate
  // enhancement — gh pr merge output doesn't include the commit SHA).
  let mergeCommit: string | undefined;
  if (!mechResult.ok) {
    mergeCommit = parseMergeCommit(last.summary);
  }

  // Restore checkout to mainline BEFORE persisting state (routeStepOutcome).
  // Combined with idempotent merge (already-merged tolerance), a crash
  // mid-restoration is recoverable: resume re-enters merged step, merge
  // short-circuits as already-done, restoration runs again.
  if (mergeSucceeded) {
    try {
      const execFn = ctx.verifyExecFn;
      if (execFn) {
        const mainlineResult = await detectMainline(ctx.repoRoot, execFn);
        if ("branch" in mainlineResult) {
          // #289 — restoreCheckout runs `git checkout <mainline>` + `pull
          // --ff-only` + `branch -d` at repoRoot. A sibling group mid-
          // integrate would find itself moved onto mainline and commit
          // there, so this takes the same lock as integration.
          const restorationNotes = await withIntegrationLock(ctx.repoRoot, () =>
            restoreCheckout(
              ctx.repoRoot,
              mainlineResult.branch,
              state.pipelineState.branchName,
              execFn,
            ),
          );
          for (const note of restorationNotes) {
            // Log restoration notes (informational — not errors).
            next = appendEvent(next, {
              kind: "plumb-report",
              at: Date.now(),
              step: "merged",
              role: "driver",
              body: `Checkout restoration: ${note}`,
            });
          }
        }
      }
      // Clean up scratch dir on merged outcome.
      await teardownWorkspaceTmp(ctx.repoRoot, state.issue);
    } catch (err) {
      // Restoration failure — log but don't halt. The merge succeeded.
      next = appendEvent(next, {
        kind: "plumb-report",
        at: Date.now(),
        step: "merged",
        role: "driver",
        body: `Checkout restoration failed: ${(err as Error).message?.slice(0, 300)}`,
      });
    }
  }

  // #287 Part E — tear down this cycle's worktrees. Best-effort: a cycle that
  // merged is done regardless, and a stuck worktree must not turn success into
  // a handoff. `worktreeRemove` was exported and never invoked before this,
  // so worktrees accumulated indefinitely (EPIC #326's done-when clause).
  const wtToRemove = Object.keys(next.pipelineState.worktrees ?? {});
  if (wtToRemove.length > 0) {
    const execFnWt = ctx.verifyExecFn ?? execp;
    // `git worktree prune` touches the shared worktree admin area, so a
    // sibling's `worktree add` can collide with it. Same lock.
    await withIntegrationLock(ctx.repoRoot, async () => {
      for (const id of wtToRemove) {
        await worktreeRemove(execFnWt, ctx.repoRoot, `issue-${ctx.issue}-${id}`, true).catch(
          (err) =>
            trace(`work-driver: worktree cleanup for '${id}' failed: ${(err as Error).message}`),
        );
      }
      await worktreePrune(execFnWt, ctx.repoRoot).catch(() => undefined);
    });
  }

  return {
    ...next,
    pipelineState: { ...next.pipelineState, currentStep: "merged", status: "merged" },
    eventLog: [...next.eventLog, { kind: "merged", at: Date.now(), prNumber, mergeCommit }],
  };
}
