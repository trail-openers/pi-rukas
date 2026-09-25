/** work-driver-handoff — Step 7g (handoff) handler. #674: worktree consolidation + forge post retry. */
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type ForgeType, detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";
import { drainSlowEvents } from "./slow-notice.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  consolidateWorktreesToBranch,
  workNotYetOnBranch,
} from "./work-driver-handoff-consolidate.ts";
import { renderHandoffMarkdown } from "./work-driver-handoff-markdown.ts";
import { runHandoffOpsDispatch } from "./work-driver-handoff-ops.ts";
import { postHandoffWithRetry } from "./work-driver-handoff-post-retry.ts";
import {
  applyIssueLabelDualTarget,
  captureCommittedWork,
  makeHandoffEmittedEvent,
  parseHandoffOpsReply,
  verifyHandoffLabel,
} from "./work-driver-handoff-post.ts";
import { captureWorktreeSnapshot } from "./work-driver-handoff-snapshot.ts";
import { releaseClaim } from "./work-driver-path-claims.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { runWorktreeTeardown } from "./work-driver-worktree-sweep.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";
// #775 prep — captureWorktreeSnapshot moved to work-driver-handoff-snapshot.ts
// (§12 file-size split); re-exported so no consumer's import path changes.
export { captureWorktreeSnapshot } from "./work-driver-handoff-snapshot.ts";
const execp = promisify(exec);
export function handoffDispatchTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 8 * 60_000;
}
export async function handoffForge(repoRoot: string): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  try {
    const det = await detectForge(repoRoot, {});
    if (det.forge === "unknown") return undefined;
    return createForge(det, { cwd: repoRoot });
  } catch {
    return undefined;
  }
}
/** Step 7g — Emit cap-hit handoff artifact. Dispatches @ops to: - render the handoff body (referencing the work-state file) - post `gh pr comment` (or `gh issue comment` if no PR yet) - apply `needs-human-attention` label After the dispatch, set status=handoff to terminate the loop. The in-process fallback (`!commentUrl || !labelApplied`) now routes its gh calls through the forge adapter — the ops child's prompt still names raw `gh` (it is a prose contract with the agent, not an exec seam), but the driver's own mechanical calls are forge-aware. */
export async function runHandoff(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "handoff" },
  };
  next = appendEvent(next, { kind: "step-started", step: "handoff", at: now });
  // #674 items 1+2 — consolidate the parked work BEFORE the snapshot, so
  // the snapshot (and the recovery printed from it) describes the world the
  // operator is actually left in. When a cycle parks at develop with
  // committed work on detached-HEAD worktrees, moving it onto the feature
  // branch here makes the branch genuinely contain the work and the printed
  // `git status` / `push` instructions true; a consolidation failure
  // degrades to the accurate per-worktree recovery (the worktrees are then
  // retained by the teardown below). Must never throw — the handoff
  // completes either way.
  const consolidated =
    process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE === "0"
      ? false
      : await handoffConsolidateWorktrees(ctx, state);
  if (consolidated) {
    next = appendEvent(next, consolidated);
  }
  // PR5: capture the worktree snapshot FIRST so handoff surfaces (in-chat
  // sendUserMessage, GitHub body, /work-status terminal) can answer
  // WHERE the work is without re-shelling git. Snapshot persists into
  // pipelineState even if subsequent steps in runHandoff fail.
  const snap = await captureWorktreeSnapshot(
    ctx.repoRoot,
    state.pipelineState.branchName,
    state.pipelineState.worktrees,
  );
  // #674 — `git status --porcelain` alone reports 0 files for committed work
  // on detached-HEAD worktrees (clean tree, commits ahead of base) — the
  // exact shape of the five parked cycles (#645/#649/#659/#660/#664). Record
  // that committed work explicitly so the "Worktree state" section and the
  // worktree-aware recovery print the work's true location instead of
  // "0 file(s) modified".
  await captureCommittedWork(snap, ctx.repoRoot, state.pipelineState);
  // In-cycle teardown: purge build artifacts and retain worktrees as needed.
  // Guarded by PI_ENSEMBLE_WORKTREE_TEARDOWN=0.
  // Wrapped in try/catch: teardown must never prevent a handoff from completing.
  // #674 — the state passed to teardown carries a synthetic handoff-emitted
  // tail (below) whose `status` is "running": the cycle has not reached its
  // terminal status until this function returns. `runWorktreeTeardown`
  // decides removal via `isWorkProvablyOnRemote`, which requires a terminal
  // status — without the override, even a successful consolidation would
  // leave every worktree behind (bug 2's accumulation). Without
  // consolidation the work is NOT on the branch, so the check fails and the
  // worktrees are retained (and named in the recovery printed from the
  // snapshot). The override only ever upgrades a check from "not terminal"
  // to "terminal": it cannot turn a false into a true for work that is not
  // provably on the branch, because the fetch + HEAD + clean-tree checks
  // still run against reality.
  if (process.env.PI_ENSEMBLE_WORKTREE_TEARDOWN !== "0") {
    try {
      const terminalState = {
        ...next,
        pipelineState: { ...next.pipelineState, status: "handoff" as const },
      };
      const retained = await runWorktreeTeardown({
        repoRoot: ctx.repoRoot,
        state: terminalState,
      });
      snap.retainedWorktrees = retained;
    } catch (err) {
      trace(`work-driver: worktree teardown failed (non-fatal): ${err}`);
    }
  }
  next = {
    ...next,
    pipelineState: { ...next.pipelineState, handoffSnapshot: snap },
  };
  // Build the handoff markdown body. Now consumes handoffSnapshot via
  // the additive sections in renderHandoffMarkdown (PR5 refinements).
  const handoffMd = renderHandoffMarkdown(next);
  const handoffBodyPath = path.join(scratchDir(ctx.repoRoot, ctx.issue), "handoff-comment.md");
  try {
    await fs.mkdir(path.dirname(handoffBodyPath), { recursive: true });
    await fs.writeFile(handoffBodyPath, handoffMd, "utf8");
  } catch (err) {
    trace(`work-driver: failed to write handoff body file: ${(err as Error).message}`);
  }
  // Dispatch @ops to post the comment + apply the label. The body file is
  // already on disk; ops just runs two `gh` invocations. Bounded by
  // handoffDispatchTimeoutMs() — see there for why a bound is safe here when
  // the deleted per-role caps were not, and why the number is what it is.
  // (The dispatch leg itself lives in work-driver-handoff-ops.ts — §12
  // file-size split; the bound, the write-ahead resume bookkeeping and the
  // completion / dispatch-failed event construction moved verbatim.)
  const prNumber = state.pipelineState.prNumber;
  const target = prNumber ? `pr #${prNumber}` : `issue #${ctx.issue}`;
  const dispatchResult = await runHandoffOpsDispatch(ctx, next, handoffBodyPath);
  next = dispatchResult.next;
  const opsReplyText = dispatchResult.opsReplyText;
  // RE-ENTRY DEDUPE (census 2026-09-09): a crash after the comment posted
  // but before the enclosing writeState left the file at "running"; resume
  // re-entered handoff and posted a SECOND comment. A prior handoff-emitted
  // event with a commentUrl is proof of delivery — reuse it (the label
  // re-application below stays: gh --add-label is idempotent server-side).
  // #775 — the ops reply is parsed for BOTH the comment URL and the label
  // state (the ops child now verifies the label with an unchained `gh …
  // --json labels` read and reports it in the HANDOFF-RESULT marker). The
  // URL parse (the SAME shared regex as `parseHandoffCommentUrl`, exercised
  // inside `parseHandoffOpsReply`) falls back to the prior handoff-emitted
  // event's URL (the re-entry dedupe) before any fallback post — the
  // invariant pinned by test-work-driver-reentry.ts.
  const parsed = parseHandoffOpsReply(opsReplyText);
  // The dedupe line, verbatim — re-entry reuses a prior event's URL and
  // never re-posts (the canary above pins the shape):
  let commentUrl = parseHandoffCommentUrl(opsReplyText) ?? priorHandoffCommentUrl(next.eventLog);
  if (parsed.commentUrl && !commentUrl) commentUrl = parsed.commentUrl;
  let labelApplied = false;
  // #798 — per-target label state. When prNumber is set, the driver labels
  // BOTH the issue (the entry-gate target) and the PR (the review target);
  // each is verified independently. When prNumber is absent, only the issue
  // is targeted and issueLabelApplied mirrors labelApplied.
  let issueLabelApplied: boolean | undefined;
  let prLabelApplied: boolean | undefined;
  // #775 — provenance of the recorded state. "dispatch" is asserted only
  // when the driver verified it (URL parsed or label read-back succeeded);
  // a reply whose state could not be verified records no provenance.
  let delivery: "dispatch" | "fallback" | undefined;
  // #775 — track whether the ops dispatch actually failed (threw or timed out)
  // so the fallback can be gated correctly: if the dispatch succeeded and
  // the URL parsed, the fallback is skipped entirely (idempotent).
  const dispatchFailed = next.eventLog
    .slice()
    .reverse()
    .some(
      (e) =>
        e.kind === "dispatch-failed" &&
        e.step === "handoff" &&
        e.role === "ops" &&
        e.label === "ops:handoff",
    );
  {
    const forge = ctx.forge ?? (await handoffForge(ctx.repoRoot));
    if (commentUrl) delivery = "dispatch";
    if (forge) {
      if (prNumber) {
        // #798 — option (a): verify the label on BOTH the issue (the entry-
        // gate target) and the PR (the review target). Each is independent;
        // a partial success records which target verified.
        const issueVerified = await verifyHandoffLabel(forge, "issue", ctx.issue);
        const prVerified = await verifyHandoffLabel(forge, "pr", prNumber);
        issueLabelApplied = issueVerified;
        prLabelApplied = prVerified;
        labelApplied = issueVerified && prVerified;
        if (labelApplied && !delivery) delivery = "dispatch";
      } else {
        const verified = await verifyHandoffLabel(forge, "issue", ctx.issue);
        issueLabelApplied = verified;
        labelApplied = verified;
        if (verified && !delivery) delivery = "dispatch";
      }
    }
  }

  // In-process fallback (with retry). When the ops dispatch failed OR the
  // commentUrl didn't parse out, the driver itself posts via the forge
  // adapter. postHandoffWithRetry retries with backoff; only after retries
  // are exhausted does the HANDOFF DISPATCH INCOMPLETE banner surface.
  if (!commentUrl || !labelApplied) {
    const forge = ctx.forge ?? (await handoffForge(ctx.repoRoot));
    try {
      if (!forge) {
        // No forge resolved — the fallback cannot run. The handoff is still
        // recorded (handoff-emitted), but the comment/label are NOT posted.
        // The operator sees the HANDOFF DISPATCH INCOMPLETE banner.
        trace("work-driver: no forge resolved — in-process fallback skipped");
      } else {
        const objType = prNumber ? "pr" : "issue";
        const targetId = prNumber ?? ctx.issue;
        const body = !commentUrl ? await fs.readFile(handoffBodyPath, "utf8").catch(() => "") : "";
        // #775 — idempotency check: fetch the target's existing comments
        // BEFORE posting so a comment the ops dispatch already posted (whose
        // URL was lost) is not re-posted. A failed dispatch leaves no such
        // comment, so the fallback posts exactly once.
        let existingComments: unknown[] | undefined;
        if (!commentUrl) {
          try {
            existingComments =
              objType === "pr"
                ? await forge.prComments(targetId)
                : await forge.issueComments(targetId);
          } catch (err) {
            trace(
              `work-driver: handoff comment-list fetch failed (non-fatal): ${(err as Error).message?.slice(0, 160)}`,
            );
          }
        }
        const posted = await postHandoffWithRetry(forge, {
          issue: ctx.issue,
          body,
          expectedBody: body,
          targetId: targetId,
          objType,
          needsComment: !commentUrl,
          // #798 — the comment target is the PR (when prNumber set), but the
          // label must land on BOTH. The retry handles the comment target's
          // label; the issue label is applied separately below.
          needsLabel: !labelApplied,
          existingComments,
        });
        if (posted.commentUrl) {
          commentUrl = posted.commentUrl;
          // #775 — the fallback established the comment URL. If the dispatch
          // also failed, this is the fallback's provenance.
          if (dispatchFailed && !delivery) delivery = "fallback";
        }
        if (prNumber) {
          // #798 — dual-target: re-verify both independently after the retry.
          const issueVerified = await verifyHandoffLabel(forge, "issue", ctx.issue);
          const prVerified = posted.labelApplied
            ? await verifyHandoffLabel(forge, "pr", prNumber)
            : (prLabelApplied ?? false);
          if (issueVerified) {
            issueLabelApplied = true;
            if (dispatchFailed) delivery = "fallback";
          }
          if (prVerified) {
            prLabelApplied = true;
            if (dispatchFailed) delivery = "fallback";
          }
          labelApplied = issueVerified && prVerified;
        } else if (posted.labelApplied) {
          issueLabelApplied = true;
          labelApplied = true;
          if (dispatchFailed) delivery = "fallback";
        }
      }
    } catch (err) {
      trace(
        `work-driver: in-process forge fallback failed: ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }
  // #798 — when prNumber is set, the fallback above applies the label to the
  // comment target (PR) via postHandoffWithRetry. The ISSUE label is applied
  // separately here because the retry only targets one object.
  if (prNumber && !issueLabelApplied) {
    const forge = ctx.forge ?? (await handoffForge(ctx.repoRoot));
    if (forge) {
      // #798 — the helper APPLIES the issue label (its return is the
      // immediately-following read-back, which can be stale/false when the
      // server-side write has not settled). The authoritative state is a
      // FRESH read — never trust the helper's first read for the record.
      const ok = await applyIssueLabelDualTarget(forge, ctx.issue);
      const verified = ok || (await verifyHandoffLabel(forge, "issue", ctx.issue));
      issueLabelApplied = verified;
      if (verified) labelApplied = true;
    }
  }
  // #674 — carry the consolidation outcome into the handoff-emitted event so the
  // renderers can print either the branch-contains-the-work path or the accurate
  // per-worktree fallback. The `handoff-consolidated` event is the audit trail.
  const consEvent = next.eventLog
    .slice()
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "handoff-consolidated" }> =>
        e.kind === "handoff-consolidated",
    );
  const emitted = makeHandoffEmittedEvent({
    at: Date.now(),
    commentUrl,
    labelApplied,
    handoffBodyPath,
    consolidated: consEvent !== undefined,
    consolidatedBranch: consEvent?.branchName,
    consolidatedWorkstreams: consEvent?.workstreams,
    consolidationReason: consEvent
      ? undefined
      : snap.committedWork?.length
        ? "consolidation infeasible (work remains on its worktree detached HEADs)"
        : undefined,
    delivery,
    targetType: prNumber ? "pr" : "issue",
    targetNumber: prNumber ?? ctx.issue,
    issueLabelApplied,
    prLabelApplied,
  });
  next = appendEvent(next, emitted);
  // #571 — release the path claim so sibling cycles can proceed.
  try {
    await releaseClaim(ctx.repoRoot, ctx.issue);
  } catch {
    /* best-effort; handoff must always emit regardless */
  }
  // Terminal status: mid-flight halts (developer-timeout, step-failed:*,
  // loop-detected, token-budget) → 'aborted'; all other caps → 'handoff'.
  const lastCapHit = [...next.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const capShape = lastCapHit?.kind === "cap-hit" ? lastCapHit.cap : undefined;
  const capKilledCap =
    capShape === "loop-detected" || capShape === "token-budget" ? capShape : undefined;
  const isMidFlightHalt =
    capShape === "developer-timeout" ||
    // #754 — a plan-timeout kill is a mid-flight halt like developer-timeout:
    // the cycle parked on a bound we chose, and the terminal status says so.
    capShape === "plan-timeout" ||
    Boolean(capKilledCap) ||
    (capShape?.startsWith("step-failed:") ?? false);
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      status: isMidFlightHalt ? "aborted" : "handoff",
    },
  };
  trace(
    `work-driver: handoff for issue #${ctx.issue} (${target}) — commentUrl=${commentUrl ?? "?"} label=${labelApplied}`,
  );
  // #799 — final drain: the handoff ops child may outlive the dispatch bound
  // (its slow watch keeps recording until it settles), and the driver's
  // step-boundary drain (routeStepOutcome, which runs after this function
  // returns) is the last persistence point this cycle gets — handoff is the
  // terminal step. Drain the buffer into the returned state so a crossing
  // recorded during the handoff leg lands in the durable log instead of
  // being discarded. A crossing recorded AFTER this drain is not persisted:
  // the cycle is done and there is no later boundary to carry it. That is
  // acceptable — the crossing is an in-session notice (the PM was already
  // notified at the moment it fired), and the driver's cycle-start drop
  // (work-driver.ts) keeps any such leftover from leaking into the next
  // cycle of this issue.
  const slowEvents = drainSlowEvents(ctx.issue);
  if (slowEvents.length > 0) {
    next = { ...next, eventLog: [...next.eventLog, ...slowEvents] };
  }
  return next;
}
/** #674 — consolidate the parked cycle's workstream work onto its feature branch BEFORE the handoff body is rendered (item 1+2 preferred fix direction). Delegates to work-driver-handoff-consolidate.ts for the actual integration (which runs under withIntegrationLock, respects integrate()'s dirty-repoRoot preflight, and degrades to a failure outcome rather than throwing). Returns the `handoff-consolidated` event to append, or undefined when consolidation was not possible (no branch, no work, no baseSha, dirty repoRoot, conflict, or git error). The caller degrades to the accurate per-worktree recovery in that case. */
export async function handoffConsolidateWorktrees(
  ctx: { repoRoot: string; issue: number },
  state: WorkState,
): Promise<WorkEvent | undefined> {
  if (process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE === "0") return undefined;
  if (!state.pipelineState.branchName) return undefined;
  const worktrees = state.pipelineState.worktrees ?? {};
  if (Object.keys(worktrees).length === 0) return undefined;
  // Re-entry guard: a second runHandoff (crash-resume re-post) must not
  // re-consolidate work that is already on the local branch.
  const notYet = await workNotYetOnBranch(
    execp as unknown as ExecFn,
    ctx.repoRoot,
    state.pipelineState.branchName,
    state.pipelineState.baseSha,
    worktrees,
  );
  if (!notYet) {
    trace("work-driver: handoff consolidation skipped — work already on the local branch");
    return undefined;
  }
  const scratch = scratchDir(ctx.repoRoot, ctx.issue);
  const result = await consolidateWorktreesToBranch(
    { repoRoot: ctx.repoRoot, issue: ctx.issue, scratchDir: scratch },
    state,
  );
  if (!result.ok) {
    trace(`work-driver: handoff consolidation degraded: ${result.reason}`);
    return undefined;
  }
  const branch = result.branchName ?? state.pipelineState.branchName;
  if (!branch) return undefined; // no branchName — cannot consolidate
  return {
    kind: "handoff-consolidated",
    at: Date.now(),
    branchName: branch,
    workstreams: result.workstreams ?? [],
  };
}
export function parseHandoffCommentUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/https:\/\/github\.com\/[^\s)>]+#issuecomment-\d+/);
  return m?.[0];
}
/**
 * The comment URL a PREVIOUS handoff attempt already delivered, if any —
 * the re-entry dedupe key (census 2026-09-09: a crash between the comment
 * post and the enclosing writeState re-posted a duplicate on resume). Pure;
 * newest event wins.
 */
export function priorHandoffCommentUrl(eventLog: readonly WorkEvent[]): string | undefined {
  const prior = [...eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "handoff-emitted" }> => e.kind === "handoff-emitted",
    );
  const url = prior?.commentUrl;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}
