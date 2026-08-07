/**
 * work-driver-branch-develop — Step 3 (branch) + Step 4 (develop) handlers.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Grouped
 * together as natural pipeline-adjacent steps: branch creates the
 * worktree(s) develop then fans a developer into.
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { trace } from "./trace.ts";
import { mechanizedBranchSetup } from "./work-driver-branch-mechanized.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { parseBranchName } from "./work-driver-diff.ts";
import { cachedIssueTitle } from "./work-driver-integrate.ts";
import { buildCompletionEvent, runSingleDispatch } from "./work-driver-merged.ts";
import { sliceMarkdownSection } from "./work-driver-plan.ts";
import { findOpenPrForIssue, prPreflightEnabled } from "./work-driver-pr-preflight.ts";
import {
  inlineBranchPrompt,
  inlineDevelopPrompt,
  inlineSpeculativeExplorePrompt,
} from "./work-driver-prompts-early.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * Step 3 — Setup: ops creates the feature branch + worktrees.
 *
 * The ops subagent enforces the branch-step safety preconditions:
 * clean working tree, fast-forward mainline, then create
 * `feature/issue-N-<brief>` branch. The driver stores the branch name in
 * pipelineState once the dispatch returns so subsequent steps can compose
 * worktree paths and the PR URL.
 *
 * #292 — branchName is resolved from git, NOT from the ops reply. Pre-fix
 * the driver parsed branchName from the ops reply via parseBranchName and
 * stored it verbatim. On live issue #277 the ops subagent reported a branch
 * name unrelated to the issue, and the real work was on a different branch.
 * Now: `git rev-parse --abbrev-ref HEAD` is the source of truth. If the
 * reported name disagrees, a plumb-report is emitted.
 */
export async function runBranch(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const workstreamIds = Object.keys(state.pipelineState.workstreams ?? {});
  // Reassigned only when the mechanized path falls back, to carry its
  // plumb-report into the ops dispatch below.
  let base = state;
  const execFnPre = ctx.verifyExecFn ?? execp;
  // #362 — pre-flight BEFORE the dispatch. `--restart` wipes the state file
  // but not GitHub, so without this the driver rebuilds an issue that already
  // has an open PR and opens a second one (#358 orphaned by #359). Halting
  // here costs zero tokens; halting after develop costs a whole cycle.
  if (prPreflightEnabled()) {
    const existing = await findOpenPrForIssue(execFnPre, ctx.repoRoot, ctx.issue);
    if (existing) {
      const withPr: WorkState = {
        ...state,
        pipelineState: { ...state.pipelineState, currentStep: "branch", existingPr: existing },
      };
      return appendEvent(withPr, {
        kind: "cap-hit",
        at: now,
        cap: "existing-pr-detected",
        reviewRound: 0,
        nextStep: "handoff",
      });
    }
  }
  // #287 — mechanized, always-worktree branch setup. Development never
  // happens at repoRoot: every workstream (including the degenerate N=1
  // `default`) gets a detached worktree, and repoRoot is touched only by
  // `integrate()` at commit-pr. #393 removed the two knobs that used to gate
  // this — both restored the pre-#287 shape that swept stale repoRoot residue
  // into a merged PR. The LLM ops dispatch below remains as the fallback for
  // env variance, which is recovery, not an opt-out.
  {
    const execFnMech = ctx.verifyExecFn ?? execp;
    try {
      const setup = await mechanizedBranchSetup(
        execFnMech,
        ctx.repoRoot,
        ctx.issue,
        activeIssuesOf(state),
        workstreamIds,
        await cachedIssueTitle(state),
      );
      const started = appendEvent(
        { ...state, pipelineState: { ...state.pipelineState, currentStep: "branch" } },
        { kind: "step-started", step: "branch", at: now },
      );
      const done = appendEvent(started, {
        kind: "dispatch-completed",
        step: "branch",
        role: "driver",
        jobId: "mechanized",
        label: "driver:branch",
        ok: true,
        ms: 0,
        at: Date.now(),
        summary: `Mechanized branch setup: ${setup.branchName} @ ${setup.baseSha.slice(0, 8)} off origin/${setup.mainline}; ${Object.keys(setup.worktrees).length} worktree(s).`,
      });
      return {
        ...done,
        pipelineState: {
          ...done.pipelineState,
          branchName: setup.branchName,
          baseSha: setup.baseSha,
          worktrees: setup.worktrees,
        },
      };
    } catch (err) {
      trace(
        `work-driver: mechanized branch setup fell back to ops dispatch: ${(err as Error).message?.slice(0, 200)}`,
      );
      base = appendEvent(base, {
        kind: "plumb-report",
        at: Date.now(),
        step: "branch",
        role: "driver",
        body: `Mechanized branch setup failed, falling back to the ops dispatch: ${(err as Error).message?.slice(0, 300)}`,
      });
    }
  }
  let next = await runSingleDispatch(ctx, base, "branch", "ops", "ops", now, () =>
    inlineBranchPrompt(activeIssuesOf(base), workstreamIds, scratchDir(ctx.repoRoot, ctx.issue)),
  );
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  // Parse the ops reply for reference (used in mismatch plumb-report only).
  const reportedBranch = parseBranchName(last.summary);
  // #292 — resolve the actual branch from git, not from the subagent reply.
  const execFn = ctx.verifyExecFn ?? execp;
  let actualBranch: string | undefined;
  try {
    const { stdout } = await execFn("git rev-parse --abbrev-ref HEAD", {
      cwd: ctx.repoRoot,
      maxBuffer: 64 * 1024,
    });
    actualBranch = stdout.trim() || undefined;
  } catch (err) {
    trace(
      `work-driver: git rev-parse --abbrev-ref HEAD failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
  // Determine the branch name: git-resolved (source of truth), fallback to
  // parsed reply if git is unavailable.
  const branch = actualBranch ?? reportedBranch;
  // #292 — emit a plumb-report if reported-vs-actual mismatch.
  if (actualBranch && reportedBranch && actualBranch !== reportedBranch) {
    const body = [
      "[ensemble:plumb]",
      "category: scope-ambiguity",
      "file: work-driver-branch-develop.ts:runBranch",
      "question: ops reported branch name differs from the branch actually checked out.",
      `reported: ${reportedBranch}`,
      `actual (git rev-parse --abbrev-ref HEAD): ${actualBranch}`,
      "The driver uses the git-resolved branch. Verify the ops dispatch executed the intended branch creation.",
    ].join("\n");
    next = appendEvent(next, {
      kind: "plumb-report",
      step: "branch",
      role: "ops",
      body,
      at: now,
    });
  }
  const ps: typeof next.pipelineState = { ...next.pipelineState };
  if (branch) ps.branchName = branch;
  // Parse worktree assignments (PR3 multi-workstream). For N=1 default
  // workstream, ops doesn't create an actual worktree — driver records
  // `{default: ctx.repoRoot}` so downstream Steps 4/5/7 use the same
  // map-iteration code path uniformly. For N>1, ops returns a fenced
  // `## Worktrees` block mapping workstream id → absolute path.
  const worktrees =
    workstreamIds.length > 1
      ? parseWorktreesBlock(last.summary ?? "", ctx.repoRoot)
      : { default: ctx.repoRoot };
  ps.worktrees = worktrees;
  // PR17 — record the base SHA the feature branch grew from. At this
  // point the branch was just created and has zero commits, so HEAD at
  // repoRoot IS the base. verifyStepOutcome diffs against this to prove
  // develop produced real changes. Best-effort: a git failure leaves
  // baseSha unset and the verifier falls back to porcelain-only checks.
  try {
    const { stdout } = await execFn("git rev-parse HEAD", {
      cwd: ctx.repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim()) ps.baseSha = stdout.trim();
  } catch (err) {
    trace(
      `work-driver: baseSha capture failed: ${(err as Error).message?.slice(0, 200)} (verify gate falls back to porcelain-only)`,
    );
  }
  return { ...next, pipelineState: ps };
}

/**
 * Parse a fenced `## Worktrees` block from ops's branch reply.
 *
 * Expected format:
 *
 *   ## Worktrees
 *
 *   - task-a: /Users/dev/projects/foo/.worktrees/issue-553-task-a
 *   - task-b: /Users/dev/projects/foo/.worktrees/issue-553-task-b
 *
 * Lenient: accepts hyphens, asterisks, optional backticks around the
 * path. Returns `{}` if no block present — caller falls back to repo
 * root for the `default` workstream.
 */
export function parseWorktreesBlock(text: string, repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  const section = sliceMarkdownSection(text, "Worktrees");
  if (section === undefined) return out;
  const lineRe = /^\s*[-*]\s*([a-z0-9][a-z0-9_-]*)\s*:\s*`?([^\s`]+)`?\s*$/gim;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
  while ((m = lineRe.exec(section))) {
    const id = (m[1] ?? "").trim();
    let p = (m[2] ?? "").trim();
    if (!path.isAbsolute(p)) p = path.resolve(repoRoot, p);
    if (id) out[id] = p;
  }
  return out;
}

/**
 * Step 4 — Implementation.
 *
 * PR3 restored multi-workstream parallelism (the "default to parallel"
 * doctrine PR #239 silently dropped). When Step 2
 * decomposed the issue into N>1 workstreams, this step fans out N
 * developers in parallel — each in its own worktree — via Promise.all
 * over driver-owned `dispatchCore` calls (the same pattern that
 * `runLensReview` uses for its 6 lens children).
 *
 * For N=1 (the `default` workstream synthesised by Step 2), the existing
 * `runSingleDispatch` path runs unchanged — N=1 isn't a special case,
 * just the degenerate one. Both paths populate the SAME event log shape;
 * downstream Steps 5 (adversarial) and 7 (lens-review) see a single
 * coherent diff via `fetchDiff` whether N=1 or N>1.
 *
 * Partial failures don't abort the join: each branch is try/catch'd
 * inside the `Promise.all`. Adversarial sees the aggregate; the
 * `branches-converged` event records which branches succeeded.
 */
export async function runDevelop(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const ids =
    Object.keys(state.pipelineState.workstreams ?? {}).length > 0
      ? Object.keys(state.pipelineState.workstreams ?? {})
      : ["default"];
  // PR11 — thread the ACTIVE issue list (NEEDS_WORK subset after
  // explore) into developer + speculative-explore prompts, not the
  // primary cycle issue. activeIssuesOf falls back to [ctx.issue] for
  // single-issue cycles so existing behaviour is preserved.
  const activeIssues = activeIssuesOf(state);

  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "develop" },
  };
  next = appendEvent(next, { kind: "step-started", step: "develop", at: now });
  // Only emit branches-fanned-out for N>1 (N=1 stays terse in scrollback).
  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-fanned-out",
      step: "develop",
      workstreams: ids,
      at: now,
    });
  }

  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const scratchAbs = scratchDir(ctx.repoRoot, ctx.issue);
  // PR4 Pattern 3: speculative just-in-time explore alongside each developer.
  // Wall-clock cost is the developer's elapsed (always longer than explore);
  // token cost is one extra explore per workstream. Opt-out via env var for
  // budget-sensitive users.
  // The speculative explore doubles develop's fanout — one extra child per
  // workstream — for what the comment above calls best-effort observability.
  // Fair for a single cycle; under a pool it is the difference between M and
  // 2M children per cycle, multiplied by the concurrency. So: on at
  // concurrency 1, off when groups run concurrently, and the env var wins
  // either way.
  const speculativeEnv = process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
  const speculativeOn =
    speculativeEnv === "0" ? true : speculativeEnv === "1" ? false : (ctx.parallelCycles ?? 1) <= 1;
  const verdicts: Array<{ id: string; ok: boolean }> = [];
  const branchEvents: typeof next.eventLog = [];
  // #382 — write-ahead. `develop` is the longest-running step in the cycle
  // and the biggest crash window; covering only `runSingleDispatch` (which
  // this fan-out does not use) would have left exactly that window uncovered.
  // One marker for the whole step: resume granularity is the step, and a
  // half-finished fan-out is re-entered wholesale.
  const begun = await beginDispatch(
    ctx.repoRoot,
    next,
    "develop",
    "developer",
    ids.length > 1 ? `developer×${ids.length}` : "developer",
    Date.now(),
  );
  next = begun.state;
  const results = await Promise.all(
    ids.map(async (id) => {
      const ws = state.pipelineState.workstreams?.[id];
      const cwd = state.pipelineState.worktrees?.[id] ?? ctx.repoRoot;
      const startedAt = Date.now();
      const developerLabel = ids.length > 1 ? `developer[${id}]` : "developer";
      const speculativeContextPath = path.join(scratchAbs, `speculative-${id}.md`);
      try {
        // Fire developer + (optional) speculative explore CONCURRENTLY.
        // The explore writes its findings to a scratch file before
        // returning so the developer can consult it mid-flight (the
        // developer prompt names the path explicitly). Promise.allSettled
        // ensures one failing doesn't abort the other.
        const [developerSettled, speculativeSettled] = await Promise.allSettled([
          dispatch(
            ctx.pi,
            {
              role: "developer",
              prompt: inlineDevelopPrompt(
                activeIssues,
                scratchAbs,
                ws,
                ids.length > 1 ? id : undefined,
                speculativeOn ? speculativeContextPath : undefined,
              ),
              cwd,
            },
            { label: developerLabel },
          ),
          speculativeOn
            ? dispatch(
                ctx.pi,
                {
                  role: "explore",
                  prompt: inlineSpeculativeExplorePrompt(
                    activeIssues,
                    ws,
                    speculativeContextPath,
                    scratchAbs,
                  ),
                  cwd,
                },
                { label: ids.length > 1 ? `explore:speculative[${id}]` : "explore:speculative" },
              )
            : Promise.resolve(null),
        ]);
        // Record the speculative outcome (best-effort observability;
        // failure is non-fatal — the developer ran on whatever context
        // Step 1's explore + the scratch file provided).
        if (speculativeSettled.status === "fulfilled" && speculativeSettled.value !== null) {
          const specEvent = await buildCompletionEvent(
            ctx,
            "develop",
            "explore",
            ids.length > 1 ? `explore:speculative[${id}]` : "explore:speculative",
            speculativeSettled.value,
          );
          branchEvents.push(specEvent);
        } else if (speculativeSettled.status === "rejected") {
          trace(
            `work-driver: speculative explore for workstream ${id} threw: ${(speculativeSettled.reason as Error).message?.slice(-200)}`,
          );
        }
        if (developerSettled.status === "rejected") {
          throw developerSettled.reason;
        }
        const res = developerSettled.value;
        const ok = res.ok && !res.errorStop;
        const completionEvent = await buildCompletionEvent(
          ctx,
          "develop",
          "developer",
          developerLabel,
          res,
        );
        branchEvents.push(completionEvent);
        if (ids.length > 1) {
          branchEvents.push({
            kind: "branch-completed",
            step: "develop",
            workstreamId: id,
            ok,
            ms: Date.now() - startedAt,
            at: Date.now(),
          });
        }
        verdicts.push({ id, ok });
        return { id, ok };
      } catch (err) {
        const errMsg = (err as Error).message?.slice(0, 200);
        branchEvents.push({
          kind: "dispatch-failed",
          step: "develop",
          role: "developer",
          jobId: "unknown",
          label: developerLabel,
          ms: Date.now() - startedAt,
          at: Date.now(),
          errorTail: errMsg,
        });
        if (ids.length > 1) {
          branchEvents.push({
            kind: "branch-completed",
            step: "develop",
            workstreamId: id,
            ok: false,
            ms: Date.now() - startedAt,
            at: Date.now(),
            error: errMsg,
          });
        }
        verdicts.push({ id, ok: false });
        return { id, ok: false };
      }
    }),
  );
  void results;
  next = appendEvent(clearDispatch(next, begun.jobId), ...branchEvents);
  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-converged",
      step: "develop",
      verdicts,
      at: Date.now(),
    });
  }
  // PR17 — outcome verification gate. Only when every branch claims
  // success (failed branches already route through the dispatch-failed
  // HALT machinery); the gate exists to catch the OTHER case, where all
  // claims are green but the evidence isn't: no diff anywhere, or the
  // project's verify command (typecheck/test) fails on the produced
  // code. Catching a broken build here saves the full adversarial →
  // lens → CI round-trip that would otherwise discover it post-PR.
  if (verdicts.every((v) => v.ok)) {
    const gate = await verifyStepOutcome(ctx, next, "develop");
    if (!gate.ok) {
      trace(`work-driver: verify-failed:develop — ${gate.failures.join(" | ")}`);
      next = {
        ...next,
        pipelineState: {
          ...next.pipelineState,
          verifyEvidence: { step: "develop", failures: gate.failures, at: Date.now() },
        },
      };
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "verify-failed:develop",
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
  }
  return next;
}
