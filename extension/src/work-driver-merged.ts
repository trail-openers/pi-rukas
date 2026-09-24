/**
 * work-driver-merged — Step 9 (merged) handler + the generic single-
 * dispatch helper + merge-reply parsing + dispatch-completion event builder.
 *
 * `buildCompletionEvent` maps DispatchResult → WorkEvent; `runSingleDispatch`
 * is the generic step body (branch, lens-fix, step-back, ci, merged);
 * `parseMergeCommit` + `runMerged` are the Step 9 pair.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { readDoctrineAtBase } from "./work-driver-doctrine.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import { detectMainline, restoreCheckout } from "./work-driver-git.ts";
import { heartbeatEventFor, shouldEmitHeartbeat } from "./work-driver-heartbeat.ts";
import { withIntegrationLock } from "./work-driver-integrate.ts";
import {
  gatherMergeEvidence,
  heldByUnresolvedReview,
  mergeAuthorityEnabled,
  resolveMergeAuthority,
} from "./work-driver-merge-authority.ts";
import { type MergeMethod, mechanizedMerge } from "./work-driver-merged-mechanized.ts";
import { releaseClaim } from "./work-driver-path-claims.ts";
import { DOCTRINE_FILES, type DoctrineDoc, judgePolicy } from "./work-driver-policy.ts";
import { inlineMergePrompt } from "./work-driver-prompts-late.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { activeIssuesOf, scratchDir, teardownWorkspaceTmp } from "./work-driver-workspace.ts";
import { type WorkState, type WorkStep, appendEvent, writeState } from "./workflow-state.ts";
import { worktreePrune, worktreeRemove } from "./worktree.ts";

const execp = promisify(exec);

export { buildCompletionEvent } from "./work-driver-completion-event.ts";

/**
 * Step 6 — Parse `pr: <N>` from an ops commit-pr reply. Lenient — accepts
 * surrounding markdown emphasis (`**pr**: 556`), backticks (`pr: #556`,
 * `pr: \`#556\``), and the bare-or-`#`-prefixed number. Returns `undefined`
 * when no marker line is present.
 */
export function parsePrNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*\*{0,2}pr\*{0,2}\s*:\s*`?#?(\d+)`?\s*$/im);
  if (!m) return undefined;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * PR10 — Parse a `merge-commit: <sha>` marker line from ops's merge reply.
 * Lenient: accepts surrounding markdown (`**merge-commit:**`), backticks,
 * and the 7+ hex-char SHA shape `gh pr merge` prints. Returns undefined
 * when no marker is present (the merge still succeeded; we just lost the
 * SHA for the merged event payload).
 */
export function parseMergeCommit(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*[*_`]*\s*merge-commit\b[^0-9a-f\n]*([0-9a-f]{7,40})[^0-9a-f\n]*$/im);
  return m?.[1];
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
  let hbState = next; // the loop below reassigns as heartbeats are appended
  let result: DispatchResult | undefined;
  try {
    // PR15 — per-call timeout override (3-min default; runCi lifts it to 30).
    // #799 task-a — the heartbeat seam: `dispatchPromise` is captured BEFORE
    // the first await, so the dispatch runs (and the child works) while the
    // wrapper loop below sleeps out heartbeat intervals and persists a
    // bounded snapshot (turns / last tool / elapsed / tokens — no
    // transcript, mirroring dispatch_peek's contract) for every interval
    // that elapses while the child is still in flight. The common case — a
    // dispatch that finishes in under one interval (15 min) — takes the
    // early-exit below and emits ZERO heartbeat events. The await of the
    // promise never changes what the dispatch sees: same promise, same
    // resolution; the loop only observes. A heartbeat never kills, signals
    // or delays the child (out of scope per the ticket: no new killCause,
    // no wall-clock bound) — its only side effects are an appended event +
    // a state write (crash-resume: a mid-heartbeat crash is recorded as the
    // dispatch still in flight, exactly as if it had died two seconds later).
    const dispatchPromise = dispatch(
      ctx.pi,
      // `cwd` matters when work lives elsewhere (lens-fix: worktree, not repoRoot).
      { role, prompt: buildPrompt(), ...(opts?.cwd ? { cwd: opts.cwd } : {}) },
      { label, timeoutMs: opts?.timeoutMs },
    );
    // #799 task-a — track the dispatch's settlement directly. `Promise.race`
    // with a sentinel does NOT work for this: a settled promise's
    // microtask resolves AFTER the sentinel, so the race always returns
    // `false` even when the dispatch is done. The `.then` flag is set by
    // the promise's own microtask and is accurate on the next tick of the
    // event loop (one `setTimeout` round-trip), which is the granularity
    // the heartbeat loop operates at.
    let dispatchSettled = false;
    dispatchPromise.then(
      () => {
        dispatchSettled = true;
      },
      () => {
        dispatchSettled = true;
      },
    );
    for (;;) {
      const tick = shouldEmitHeartbeat(startedAt, Date.now());
      if (!tick.enabled) break; // disabled (PI_ENSEMBLE_DISPATCH_HEARTBEAT_MS=0)
      if (!tick.due) {
        // Not due yet: the dispatch is the only work to do — await it
        // directly. If it settles, we're done; if it takes longer than
        // the interval, the loop re-checks on the next iteration (the
        // `dispatchSettled` flag will be true by then).
        try {
          result = await dispatchPromise;
        } catch (err) {
          return appendEvent(clearDispatch(hbState, jobId), {
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
        break;
      }
      // Due: sleep until the tick, emit the heartbeat, then check whether
      // the dispatch settled while we were persisting. If it did, the
      // completion event is the final record and the loop ends. If not,
      // the loop re-checks at the top of the next iteration.
      await new Promise((r) => setTimeout(r, Math.max(0, tick.dueAt - Date.now())));
      const ev = heartbeatEventFor({
        step,
        role,
        label,
        jobId,
        startedAt,
        now: Date.now(),
        state: hbState,
      });
      if (ev) {
        hbState = appendEvent(hbState, ev);
        await writeState(ctx.repoRoot, hbState).catch((err) =>
          trace(`work-driver: heartbeat persist failed: ${(err as Error).message}`),
        );
      }
      if (dispatchSettled) {
        try {
          result = await dispatchPromise;
        } catch (err) {
          return appendEvent(clearDispatch(hbState, jobId), {
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
        break;
      }
      // Not settled yet — the dispatch is still running. Wait a short
      // grace period (one tick of the event loop, so the `dispatchSettled`
      // flag can catch up) and re-check. If the dispatch settles during
      // this grace, the next iteration's `dispatchSettled` check catches it.
      await new Promise((r) => setTimeout(r, 1));
    }
  } catch (err) {
    // Reaching here means the loop broke on `!tick.enabled` (disabled) or
    // the promise threw in a way the sentinel race did not convert — the
    // `hbState` (not `next`) carries any heartbeats already appended, so
    // the failed-dispatch event lands on the right tail either way.
    return appendEvent(clearDispatch(hbState, jobId), {
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
  // #799 task-a — the loop guarantees an assignment on every non-return
  // path (the `!tick.enabled` break is the only assignment-less exit and
  // `dispatchPromise` is a pending promise, so this is unreachable at
  // runtime — the union type is a documentation aid, not a second check).
  if (!result) {
    return appendEvent(clearDispatch(hbState, jobId), {
      kind: "dispatch-failed",
      step,
      role,
      jobId,
      label,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: "dispatch-heartbeat seam: loop exited without a result (unreachable)",
    });
  }
  const event = await buildCompletionEvent(ctx, step, role, label, result);
  // Clear the in-flight marker whichever way the dispatch settled — a
  // completed dispatch that still looks in-flight would make the next
  // invocation resume a step that already finished.
  // `hbState` (not `next`): it carries the heartbeats the loop appended.
  return appendEvent(clearDispatch(hbState, jobId), event);
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

  // #380 — two independent gates, both defaulting to "no". Merging is the
  // one irreversible act in the cycle and had neither; a green PR ≠ permission.
  if (mergeAuthorityEnabled()) {
    const execFnAuth = ctx.verifyExecFn ?? execp;
    // #406 — doctrine is read at the BASE commit, never from the working tree.
    // This step runs after commit-pr integrated the developer's patches, so an
    // AGENTS.md read from disk here would include any grant a subagent just
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
    const routedRoundCap = heldByUnresolvedReview(state.eventLog);
    if (!authority.granted || !evidence?.ok || routedRoundCap) {
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
            ...(evidence?.failureKind ? { evidenceFailureKind: evidence.failureKind } : {}),
            ...(evidence?.inconclusive?.length ? { inconclusive: evidence.inconclusive } : {}),
            ...(routedRoundCap ? { unresolvedReviewFindings: true } : {}),
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
      // #476 — same seam resolution as mechanizedMerge (#380): the test-only
      // injection is the preferred path when present, but production callers
      // omit it and would have skipped restoration entirely, leaving the
      // checkout on the merged feature branch with no prune and no local
      // branch -d attempt.
      const execFn = ctx.verifyExecFn ?? execp;
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

  // #571 — release the path claim on successful merge.
  try {
    await releaseClaim(ctx.repoRoot, ctx.issue);
  } catch {
    /* best-effort; merge must always succeed regardless */
  }
  return {
    ...next,
    pipelineState: { ...next.pipelineState, currentStep: "merged", status: "merged" },
    eventLog: [...next.eventLog, { kind: "merged", at: Date.now(), prNumber, mergeCommit }],
  };
}
