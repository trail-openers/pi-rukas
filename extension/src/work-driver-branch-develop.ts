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
import type { DriverContext } from "./work-driver-context.ts";
import { parseBranchName } from "./work-driver-diff.ts";
import { buildCompletionEvent, runSingleDispatch } from "./work-driver-merged.ts";
import { sliceMarkdownSection } from "./work-driver-plan.ts";
import {
  inlineBranchPrompt,
  inlineDevelopPrompt,
  inlineSpeculativeExplorePrompt,
} from "./work-driver-prompts-early.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * Step 3 — Setup: ops creates the feature branch + worktrees.
 *
 * The ops subagent enforces the safety preconditions in /work.md Step 3:
 * clean working tree, fast-forward mainline, then create
 * `feature/issue-N-<brief>` branch. The driver stores the branch name in
 * pipelineState once the dispatch returns so subsequent steps can compose
 * worktree paths and the PR URL.
 *
 * v1 simplification: the driver does not parse the branch name out of the
 * ops reply — it leaves pipelineState.branchName undefined and lets the
 * subsequent steps include the issue number in their prompts, asking the
 * @developer / @ops to discover the branch via `git rev-parse --abbrev-ref HEAD`
 * in the worktree. A future version with a structured-output schema on
 * @ops can populate pipelineState.branchName explicitly.
 */
export async function runBranch(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const workstreamIds = Object.keys(state.pipelineState.workstreams ?? {});
  const next = await runSingleDispatch(ctx, state, "branch", "ops", "ops", now, () =>
    inlineBranchPrompt(activeIssuesOf(state), workstreamIds, scratchDir(ctx.repoRoot, ctx.issue)),
  );
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const branch = parseBranchName(last.summary);
  // Parse worktree assignments (PR3 multi-workstream). For N=1 default
  // workstream, ops doesn't create an actual worktree — driver records
  // `{default: ctx.repoRoot}` so downstream Steps 4/5/7 use the same
  // map-iteration code path uniformly. For N>1, ops returns a fenced
  // `## Worktrees` block mapping workstream id → absolute path.
  const worktrees =
    workstreamIds.length > 1
      ? parseWorktreesBlock(last.summary ?? "", ctx.repoRoot)
      : { default: ctx.repoRoot };
  const ps: typeof next.pipelineState = { ...next.pipelineState, worktrees };
  if (branch) ps.branchName = branch;
  // PR17 — record the base SHA the feature branch grew from. At this
  // point the branch was just created and has zero commits, so HEAD at
  // repoRoot IS the base. verifyStepOutcome diffs against this to prove
  // develop produced real changes. Best-effort: a git failure leaves
  // baseSha unset and the verifier falls back to porcelain-only checks.
  try {
    const execFn = ctx.verifyExecFn ?? execp;
    const { stdout } = await execFn("git rev-parse HEAD", {
      cwd: ctx.repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim()) ps.baseSha = stdout.trim();
  } catch {
    trace("work-driver: baseSha capture failed (verify gate falls back to porcelain-only)");
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
 * PR3 restored multi-workstream parallelism (the original /work.md
 * "default to parallel" doctrine PR #239 silently dropped). When Step 2
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
  const speculativeOn = process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE !== "1";
  const verdicts: Array<{ id: string; ok: boolean }> = [];
  const branchEvents: typeof next.eventLog = [];
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
  next = appendEvent(next, ...branchEvents);
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
