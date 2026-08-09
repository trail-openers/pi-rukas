/**
 * work-driver-handoff — Step 7g (handoff) handler.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Renders
 * the handoff markdown body (work-driver-handoff-markdown.ts), dispatches
 * @ops to post it + apply the needs-human-attention label, and falls back
 * to an in-process `gh` call on any dispatch/parse failure.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { renderHandoffMarkdown } from "./work-driver-handoff-markdown.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { inlineHandoffOpsPrompt } from "./work-driver-prompts-late.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * Step 7g — Emit cap-hit handoff artifact.
 *
 * Dispatches @ops to:
 *  - render the handoff body (referencing the work-state file)
 *  - post `gh pr comment` (or `gh issue comment` if no PR yet)
 *  - apply `needs-human-attention` label
 *
 * After the dispatch, set status=handoff to terminate the loop.
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
  // already on disk; ops just runs two `gh` invocations — but its LLM
  // turns are not free: a thinking-heavy model needs 10+ min for a single
  // turn, and PR5's tight 3-min budget SIGTERM'd the RECOVERY path itself
  // (#296, lantern 592/595/596: exit-143 kills at exactly 180000ms). 15 min
  // gives one long turn headroom; the in-process gh fallback below still
  // takes over on any failure, so the user never silently loses the
  // artefact.
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  const prNumber = state.pipelineState.prNumber;
  const target = prNumber ? `pr #${prNumber}` : `issue #${ctx.issue}`;
  const prompt = inlineHandoffOpsPrompt(
    ctx.issue,
    prNumber,
    handoffBodyPath,
    scratchDir(ctx.repoRoot, ctx.issue),
  );
  let opsReplyText = "";
  try {
    const res = await dispatch(
      ctx.pi,
      { role: "ops", prompt },
      { label: "ops:handoff", timeoutMs: 15 * 60_000 },
    );
    opsReplyText = res.text ?? "";
    const completionEvent = await buildCompletionEvent(ctx, "handoff", "ops", "ops:handoff", res);
    next = appendEvent(next, completionEvent);
  } catch (err) {
    trace(`work-driver: handoff ops dispatch threw: ${(err as Error).message}`);
    next = appendEvent(next, {
      kind: "dispatch-failed",
      step: "handoff",
      role: "ops",
      jobId: "unknown",
      label: "ops:handoff",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
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
    try {
      const targetId = String(prNumber ?? ctx.issue);
      const objType = prNumber ? "pr" : "issue";
      if (!commentUrl) {
        const { stdout } = await execp(
          `gh ${objType} comment ${targetId} --body-file ${JSON.stringify(handoffBodyPath)}`,
          { cwd: ctx.repoRoot, timeout: 60_000 },
        );
        const parsedUrl = parseHandoffCommentUrl(stdout) ?? stdout.trim();
        if (parsedUrl) commentUrl = parsedUrl;
      }
      if (!labelApplied) {
        // Create the label first (idempotent — ignore "already exists" error).
        try {
          await execp(
            "gh label create needs-human-attention --color FFAA00 " +
              '--description "Agent loop hit a cap; human review required"',
            { cwd: ctx.repoRoot, timeout: 15_000 },
          );
        } catch {
          /* already exists or no perms; continue */
        }
        await execp(`gh ${objType} edit ${targetId} --add-label needs-human-attention`, {
          cwd: ctx.repoRoot,
          timeout: 30_000,
        });
        labelApplied = true;
      }
    } catch (err) {
      trace(`work-driver: in-process gh fallback failed: ${(err as Error).message?.slice(0, 200)}`);
    }
  }

  next = appendEvent(next, {
    kind: "handoff-emitted",
    at: Date.now(),
    commentUrl,
    labelApplied,
    handoffBodyPath,
  });
  // Set terminal status from the most recent cap-hit's cap shape:
  //   - step-failed:<step> or developer-timeout → 'aborted' (the
  //     halt-cascade router synthesised this; mid-flight failure)
  //   - any other cap (adversarial-loop, round-cap, wall-clock,
  //     ci-retry) → 'handoff' (cycle reached handoff via the verdict
  //     path, not via dispatch-failure)
  const lastCapHit = [...next.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const capShape = lastCapHit?.kind === "cap-hit" ? lastCapHit.cap : ("adversarial-loop" as const);
  const isMidFlightHalt = capShape === "developer-timeout" || capShape.startsWith("step-failed:");
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
