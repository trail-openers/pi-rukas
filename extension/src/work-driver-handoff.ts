/** work-driver-handoff — Step 7g (handoff) handler. #674: worktree consolidation + forge post retry. */
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { type ForgeType, detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  consolidateWorktreesToBranch,
  workNotYetOnBranch,
} from "./work-driver-handoff-consolidate.ts";
import { renderHandoffMarkdown } from "./work-driver-handoff-markdown.ts";
import { postHandoffWithRetry } from "./work-driver-handoff-post-retry.ts";
import { captureCommittedWork, makeHandoffEmittedEvent } from "./work-driver-handoff-post.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { releaseClaim } from "./work-driver-path-claims.ts";
import { inlineHandoffOpsPrompt } from "./work-driver-prompts-late.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { runWorktreeTeardown } from "./work-driver-worktree-sweep.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";
const execp = promisify(exec);
/** Resolution of the ops handoff dispatch when it outlived its bound. */
const BOUND_EXCEEDED = Symbol("handoff-bound-exceeded");
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
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const boundMs = handoffDispatchTimeoutMs();
  const startedAt = Date.now();
  const prNumber = state.pipelineState.prNumber;
  const target = prNumber ? `pr #${prNumber}` : `issue #${ctx.issue}`;
  const prompt = inlineHandoffOpsPrompt(
    ctx.issue,
    prNumber,
    handoffBodyPath,
    scratchDir(ctx.repoRoot, ctx.issue),
  );
  // #573 — derive transcript path BEFORE beginDispatch so crash-resume can
  // locate the surviving session file. Single dispatch: seq=undefined.
  const handoffRunId = `handoff:ops:${process.pid}:${startedAt}`;
  const handoffTranscript = transcriptPathFor("ops", handoffRunId);
  // #382 — write-ahead: persist the intent to dispatch BEFORE awaiting.
  const begun = await beginDispatch(
    ctx.repoRoot,
    next,
    "handoff",
    "ops",
    "handoff",
    startedAt,
    handoffTranscript,
  );
  let opsReplyText = "";
  // Two enforcement points, deliberately: `timeoutMs` makes spawn SIGTERM the
  // real child so an abandoned handoff agent is not left running, and the race
  // is what frees the DRIVER. Only the race can be relied on — an injected
  // dispatchFn, a wedged job wrapper or a child that ignores the signal all
  // leave the promise pending, which is the shape that cost #626 26 minutes.
  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bound = new Promise<typeof BOUND_EXCEEDED>((resolve) => {
      boundTimer = setTimeout(() => resolve(BOUND_EXCEEDED), boundMs);
      boundTimer.unref?.();
    });
    const res = await Promise.race([
      dispatch(ctx.pi, { role: "ops", prompt }, { label: "ops:handoff", timeoutMs: boundMs }),
      bound,
    ]);
    next = clearDispatch(next, begun.jobId);
    if (res === BOUND_EXCEEDED) {
      trace(`work-driver: handoff ops dispatch exceeded ${boundMs}ms — using in-process gh`);
      next = appendEvent(next, {
        kind: "dispatch-failed",
        step: "handoff",
        role: "ops",
        jobId: "unknown",
        label: "ops:handoff",
        ms: Date.now() - startedAt,
        at: Date.now(),
        // Deliberately NO `killCause`. Nothing was killed — the driver stopped
        // waiting and took the fallback, and the child may still be running.
        // Tagging this as a kill would also make it the newest kill in the log,
        // so `killDetail()` would report the handoff's own bound instead of the
        // kill that actually ended the cycle — burying the cause under the
        // report of it. The errorTail below already says what happened.
        errorTail: `handoff ops dispatch exceeded its ${boundMs}ms bound (PI_ENSEMBLE_HANDOFF_TIMEOUT_MS); the in-process gh fallback posted the comment instead`,
      });
    } else {
      opsReplyText = res.text ?? "";
      const completionEvent = await buildCompletionEvent(ctx, "handoff", "ops", "ops:handoff", res);
      next = appendEvent(next, completionEvent);
    }
  } catch (err) {
    trace(`work-driver: handoff ops dispatch threw: ${(err as Error).message}`);
    next = appendEvent(clearDispatch(next, begun.jobId), {
      kind: "dispatch-failed",
      step: "handoff",
      role: "ops",
      jobId: "unknown",
      label: "ops:handoff",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  } finally {
    if (boundTimer) clearTimeout(boundTimer);
  }
  // RE-ENTRY DEDUPE (census 2026-09-09): a crash after the comment posted
  // but before the enclosing writeState left the file at "running"; resume
  // re-entered handoff and posted a SECOND comment. A prior handoff-emitted
  // event with a commentUrl is proof of delivery — reuse it (the label
  // re-application below stays: gh --add-label is idempotent server-side).
  let commentUrl = parseHandoffCommentUrl(opsReplyText) ?? priorHandoffCommentUrl(next.eventLog);
  // #408 — there is nothing to parse here. `gh --add-label` is idempotent, the
  // driver is already willing to run it, and running it is cheaper than reasoning
  // about whether an agent's prose meant success. Narration cannot establish
  // that a side effect happened; performing it can.
  let labelApplied = false;

  // PR5 in-process fallback (item 3, #674 — with retry). When the ops
  // dispatch failed OR the commentUrl didn't parse out, the driver itself
  // posts via the forge adapter — the body file is already on disk and no
  // LLM is needed for two mechanical CLI invocations. A transient API
  // hiccup (rate limit, 5xx, network blip) no longer immediately becomes a
  // manual-recovery task: postHandoffWithRetry waits out a jittered linear
  // backoff and re-issues the failed call (up to 3 attempts total), and
  // only after retries are exhausted does the in-chat HANDOFF DISPATCH
  // INCOMPLETE banner surface the verbatim manual gh commands.
  if (!commentUrl || !labelApplied) {
    const forge = ctx.forge ?? (await handoffForge(ctx.repoRoot));
    try {
      if (!forge) {
        // No forge resolved — the fallback cannot run. The handoff is still
        // recorded (handoff-emitted), but the comment/label are NOT posted.
        // The operator sees the HANDOFF DISPATCH INCOMPLETE banner.
        trace("work-driver: no forge resolved — in-process fallback skipped");
      } else {
        const targetId = String(prNumber ?? ctx.issue);
        const objType = prNumber ? "pr" : "issue";
        const body = !commentUrl ? await fs.readFile(handoffBodyPath, "utf8").catch(() => "") : "";
        const posted = await postHandoffWithRetry(forge, {
          issue: ctx.issue,
          body,
          targetId: Number(targetId),
          objType,
          needsComment: !commentUrl && objType === "issue",
          needsLabel: !labelApplied,
        });
        // The forge adapter models `issueComment` only (S2 surface). PRs
        // get their handoff comment via the ops dispatch's raw `gh` prompt.
        if (posted.commentUrl) commentUrl = posted.commentUrl;
        if (posted.labelApplied) labelApplied = true;
      }
    } catch (err) {
      trace(
        `work-driver: in-process forge fallback failed: ${(err as Error).message?.slice(0, 200)}`,
      );
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
  });
  next = appendEvent(next, emitted);
  // #571 — release the path claim so sibling cycles can proceed.
  try {
    await releaseClaim(ctx.repoRoot, ctx.issue);
  } catch {
    /* best-effort; handoff must always emit regardless */
  }
  // Set terminal status from the most recent cap-hit's cap shape:
  //   - step-failed:<step> or developer-timeout → 'aborted' (the
  //     halt-cascade router synthesised this; mid-flight failure)
  //   - any other cap (adversarial-loop, round-cap, wall-clock,
  //     ci-retry) → 'handoff' (cycle reached handoff via the verdict
  //     path, not via dispatch-failure)
  const lastCapHit = [...next.eventLog].reverse().find((e) => e.kind === "cap-hit");
  // Not a renderer — this only decides `aborted` vs `handoff`. It used to spell
  // "no cap recorded" as `"adversarial-loop"`, which happened to give the right
  // answer here (an absent cap is not a mid-flight halt) while seeding the same
  // fake cap name the renderers were misreporting. Say what is meant instead.
  const capShape = lastCapHit?.kind === "cap-hit" ? lastCapHit.cap : undefined;
  // #543 F4 — the dispatch-cap kills (loop-detected / token-budget) are
  // mid-flight halts like developer-timeout: the child was killed by the
  // harness, not by a review verdict. They route to `aborted` so the
  // operator sees a mid-flight failure, and the caped-partial-state
  // checkpoint block (F5) carries the work that was saved.
  const capKilledCap =
    capShape === "loop-detected" || capShape === "token-budget" ? capShape : undefined;
  const isMidFlightHalt =
    capShape === "developer-timeout" ||
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
/**
 * PR5 — capture a snapshot of the worktree at handoff time. Lets the
 * operator-facing surfaces (in-chat sendUserMessage, /work-status
 * terminal renderer, GitHub renderHandoffMarkdown) answer WHERE the
 * work is without re-shelling git on every call.
 *
 * Best-effort: every git invocation is try/catch'd so a missing branch /
 * gh-auth / network issue degrades gracefully — the snapshot's
 * `branchPushed: false` and empty `modifiedFiles` is meaningful by
 * itself; absence of the snapshot field is not.
 *
 * Caps file list at 50 entries to keep state-file readable; the
 * `unstagedCount + stagedCount` totals are always accurate even when
 * the per-file list is truncated.
 */
export async function captureWorktreeSnapshot(
  repoRoot: string,
  branchName: string | undefined,
  worktrees?: Record<string, string>,
): Promise<NonNullable<WorkState["pipelineState"]["handoffSnapshot"]>> {
  const snapshot: NonNullable<WorkState["pipelineState"]["handoffSnapshot"]> = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: false,
    branchPushed: false,
    headSha: "",
    capturedAt: Date.now(),
  };
  // #287 — the developer's uncommitted work lives in the WORKTREES, not at
  // repoRoot. Snapshotting repoRoot alone would report "0 files modified" on
  // exactly the handoffs where the operator needs to know what survived.
  // Scan every worktree (falling back to repoRoot when none were recorded,
  // i.e. a pre-branch halt), prefixing paths
  // with the workstream id when there is more than one so the file list is
  // unambiguous.
  const scanRoots = Object.entries(worktrees ?? {});
  const targets: Array<{ id: string | undefined; dir: string }> =
    scanRoots.length > 0
      ? scanRoots.map(([id, dir]) => ({ id: scanRoots.length > 1 ? id : undefined, dir }))
      : [{ id: undefined, dir: repoRoot }];
  // git status --porcelain (XY format: column 1 = staged tier, column 2 = unstaged tier).
  for (const { id, dir } of targets) {
    try {
      const { stdout } = await execp("git status --porcelain", {
        cwd: dir,
        maxBuffer: 256 * 1024,
      });
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        const x = line[0] ?? " ";
        const y = line[1] ?? " ";
        if (x !== " " && x !== "?") snapshot.stagedCount += 1;
        if (y !== " ") snapshot.unstagedCount += 1;
        const filePath = line.slice(3);
        if (snapshot.modifiedFiles.length < 50) {
          snapshot.modifiedFiles.push(id ? `${id}: ${filePath}` : filePath);
        }
      }
    } catch (err) {
      trace(
        `work-driver: captureWorktreeSnapshot git status failed for ${dir}: ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }
  // HEAD short SHA.
  try {
    const { stdout } = await execp("git rev-parse --short HEAD", { cwd: repoRoot });
    snapshot.headSha = stdout.trim();
  } catch (err) {
    trace(
      `work-driver: captureWorktreeSnapshot git rev-parse failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
  if (branchName) {
    // Local branch existence.
    try {
      await execp(`git rev-parse --verify ${JSON.stringify(branchName)}`, { cwd: repoRoot });
      snapshot.branchExists = true;
    } catch {
      snapshot.branchExists = false;
    }
    // Remote tracking (best-effort; network may be down). 10s timeout
    // because ls-remote can hang on unreachable remotes.
    try {
      const { stdout } = await execp(`git ls-remote --heads origin ${JSON.stringify(branchName)}`, {
        cwd: repoRoot,
        timeout: 10_000,
      });
      snapshot.branchPushed = stdout.trim().length > 0;
    } catch {
      snapshot.branchPushed = false;
    }
  }
  return snapshot;
}
