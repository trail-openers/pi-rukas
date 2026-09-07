/**
 * work-driver-handoff — Step 7g (handoff) handler.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Renders
 * the handoff markdown body (work-driver-handoff-markdown.ts), dispatches
 * @ops to post it + apply the needs-human-attention label, and falls back
 * to an in-process `gh` call on any dispatch failure, parse failure, or
 * dispatch that outlives `handoffDispatchTimeoutMs()`.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { renderHandoffMarkdown } from "./work-driver-handoff-markdown.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { releaseClaim } from "./work-driver-path-claims.ts";
import { inlineHandoffOpsPrompt } from "./work-driver-prompts-late.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { runWorktreeTeardown } from "./work-driver-worktree-sweep.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

/** Resolution of the ops handoff dispatch when it outlived its bound. */
const BOUND_EXCEEDED = Symbol("handoff-bound-exceeded");

/**
 * How long the driver waits for the ops handoff dispatch.
 *
 * This is NOT one of the six per-role wall-clock caps this project deleted
 * (spawn-support.ts `SPAWN_BACKSTOP_MS`). Those bounded open-ended work whose
 * duration is a function of the model, and every kill DESTROYED the work — the
 * finding both times they were raised was that the number was too small for a
 * healthy child. Neither property holds here. The handoff child's job is
 * enumerable: the markdown body is already on disk, so it runs
 * `gh <pr|issue> comment --body-file` and `gh <pr|issue> edit --add-label` and
 * reports the URL. And exceeding the bound destroys nothing — the in-process
 * `gh` fallback below posts the identical file and applies the identical
 * label, so the bound costs at most the parsed comment URL.
 *
 * The number: six real handoffs in this repo's `.pi/work-state` completed in
 * 6.7 s - 17.8 s. Eight minutes is ~27x the slowest of those, and leaves room
 * for one long thinking-heavy turn (#296: a 3-min cap SIGTERM'd this very
 * recovery path). Nothing bounded it before — nessie #626's handoff
 * `dispatch-completed` at 1547126 ms (25.8 min) never went silent, so the
 * inactivity watchdog could not see it, and the 2 h runaway backstop is 5x
 * further out again.
 *
 * Override: `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` (ms).
 */
export function handoffDispatchTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 8 * 60_000;
}

/**
 * Resolve the forge adapter for the in-process handoff fallback
 * (#612 S4 task-b). `PI_ENSEMBLE_FORGE=none` refuses the forge path; an
 * unknown detection falls back to raw `gh` exec (pre-migration behaviour).
 * The fallback runs at handoff time — the cycle's own forge resolution
 * would have been earlier still, but handoff is terminal and the driver
 * never carried a `Forge` before #612 — so resolve fresh.
 */
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

/**
 * Step 7g — Emit cap-hit handoff artifact.
 *
 * Dispatches @ops to:
 *  - render the handoff body (referencing the work-state file)
 *  - post `gh pr comment` (or `gh issue comment` if no PR yet)
 *  - apply `needs-human-attention` label
 *
 * After the dispatch, set status=handoff to terminate the loop.
 *
 * The in-process fallback (`!commentUrl || !labelApplied`) now routes its
 * gh calls through the forge adapter — the ops child's prompt still names
 * raw `gh` (it is a prose contract with the agent, not an exec seam), but
 * the driver's own mechanical calls are forge-aware.
 */
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

  // PR5: capture the worktree snapshot FIRST so handoff surfaces (in-chat
  // sendUserMessage, GitHub body, /work-status terminal) can answer
  // WHERE the work is without re-shelling git. Snapshot persists into
  // pipelineState even if subsequent steps in runHandoff fail.
  const snap = await captureWorktreeSnapshot(
    ctx.repoRoot,
    state.pipelineState.branchName,
    state.pipelineState.worktrees,
  );
  // In-cycle teardown: purge build artifacts and retain worktrees as needed.
  // Guarded by PI_ENSEMBLE_WORKTREE_TEARDOWN=0.
  // Wrapped in try/catch: teardown must never prevent a handoff from completing.
  if (process.env.PI_ENSEMBLE_WORKTREE_TEARDOWN !== "0") {
    try {
      const retained = await runWorktreeTeardown({
        repoRoot: ctx.repoRoot,
        state,
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

  let commentUrl = parseHandoffCommentUrl(opsReplyText);
  // #408 — this used to be `/label.*needs-human-attention/i.test(opsReplyText)`,
  // which matches "I could not apply the label needs-human-attention" just as
  // happily as a success. It recorded the label as applied, skipped the
  // mechanical fallback below, and the issue never got labelled — the operator
  // then had no way to find the cycle that needed them.
  //
  // There is nothing to parse here. `gh --add-label` is idempotent, the driver
  // is already willing to run it, and running it is cheaper than reasoning
  // about whether an agent's prose meant success. Narration cannot establish
  // that a side effect happened; performing it can.
  let labelApplied = false;

  // PR5 in-process fallback. When the ops dispatch failed OR the
  // commentUrl didn't parse out, the driver itself shells out `gh` —
  // the body file is already on disk and no LLM is needed for two
  // mechanical CLI invocations. Best-effort; if gh is missing / unauth'd
  // / network down, the in-chat HANDOFF DISPATCH INCOMPLETE banner
  // surfaces the failure with the verbatim recovery command.
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
        if (!commentUrl) {
          // The forge adapter models `issueComment` only (S2 surface). PRs
          // get their handoff comment via the ops dispatch's raw `gh` prompt.
          // For the in-process path, the forge covers the issue-comment shape.
          const isIssueComment = objType === "issue";
          if (isIssueComment) {
            const body = await fs.readFile(handoffBodyPath, "utf8").catch(() => "");
            const out = await forge.issueComment(ctx.issue, body);
            const parsedUrl = parseHandoffCommentUrl(out) ?? out.trim();
            if (parsedUrl) commentUrl = parsedUrl;
          }
        }
        if (!labelApplied) {
          // Create the label first (idempotent — ignore "already exists" error).
          try {
            await forge.labelCreate("needs-human-attention", "FFAA00");
          } catch {
            /* already exists or no perms; continue */
          }
          await forge.labelAdd(
            objType === "pr" ? "mr" : "issue",
            Number(targetId),
            "needs-human-attention",
          );
          labelApplied = true;
        }
      }
    } catch (err) {
      trace(
        `work-driver: in-process forge fallback failed: ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }

  next = appendEvent(next, {
    kind: "handoff-emitted",
    at: Date.now(),
    commentUrl,
    labelApplied,
    handoffBodyPath,
  });
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

/**
 * Parse the GitHub comment URL the @ops handoff agent should have
 * surfaced in its reply. Looks for any github.com URL matching the
 * `*#issuecomment-<id>` shape (the canonical PR/issue comment URL).
 * Returns the first hit, or undefined when ops failed / didn't surface it.
 */
export function parseHandoffCommentUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/https:\/\/github\.com\/[^\s)>]+#issuecomment-\d+/);
  return m?.[0];
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
