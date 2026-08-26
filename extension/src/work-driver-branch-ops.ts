/**
 * work-driver-branch-ops — ops-dispatch fallback for the branch step.
 *
 * Extracted from work-driver-branch-develop.ts (500-line gate, #475).
 * Owns everything the LLM ops fallback uses: the `## Worktrees` reply
 * parser, the post-dispatch git verification, and the mainline guard.
 * `runBranch` calls this after `mechanizedBranchSetup` throws something
 * other than `DirtyWorktreeError` — the recovery path #287 kept
 * deliberately: absorbing environment variance, not an opt-out.
 *
 * #533 — this path does NOT provision the worktrees it records: only
 * `worktreeCreate` (the mechanized path) calls `provisionWorktree`, and the
 * ops prompt only tells ops to `git worktree add`. A worktree without
 * `node_modules` fails the develop gate with module-not-found errors even
 * though the diff is fine, and the handoff's "add or fix `.pi/worktree-setup`"
 * advice then blames a hook that was never on the code path. The fallback is
 * an env-variance recovery, not an opt-out of provisioning — if it fires, run
 * the project's `.pi/worktree-setup` hook (or the symlink loop's equivalent)
 * in each worktree before the develop step.
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { parseBranchName } from "./work-driver-diff.ts";
import { resolvedTheMainline } from "./work-driver-git.ts";
import { buildCompletionEvent, runSingleDispatch } from "./work-driver-merged.ts";
import { sliceMarkdownSection } from "./work-driver-plan.ts";
import { inlineBranchPrompt } from "./work-driver-prompts-early.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

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
 * Run the branch step through the LLM ops dispatch (the #287 fallback)
 * and return the updated state. Called only after `mechanizedBranchSetup`
 * throws something other than `DirtyWorktreeError`.
 *
 * #292 — branchName is resolved from git, NOT from the ops reply.
 */
export async function runBranchViaOpsDispatch(
  ctx: DriverContext,
  base: WorkState,
  workstreamIds: string[],
  now: number,
): Promise<WorkState> {
  let next = await runSingleDispatch(ctx, base, "branch", "ops", "ops", now, () =>
    inlineBranchPrompt(activeIssuesOf(base), workstreamIds, scratchDir(ctx.repoRoot, ctx.issue)),
  );
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const reportedBranch = parseBranchName(last.summary);
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
  const branch = actualBranch ?? reportedBranch;
  if (await resolvedTheMainline(ctx.repoRoot, execFn, branch)) {
    trace(
      `work-driver: branch step resolved the mainline (${branch}) as the cycle branch — halting`,
    );
    return appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "step-failed:branch",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }
  if (actualBranch && reportedBranch && actualBranch !== reportedBranch) {
    const body = [
      "[ensemble:plumb]",
      "category: scope-ambiguity",
      "file: work-driver-branch-ops.ts:runBranchViaOpsDispatch",
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
  // #451 — ALWAYS parse the `## Worktrees` block when the ops reply carries
  // one, N=1 included. The `{ default: ctx.repoRoot }` entry is a LAST-RESORT
  // cwd: under the worktree-isolation epic the repo root is no longer checked
  // out on the feature branch, so a `fetchDiff` scoped to it would compare the
  // mainline against itself and an adversarial review of it would trivially
  // approve (the per-worktree `git diff HEAD` semantics are documented on
  // `fetchDiff` in work-driver-diff.ts). The ops prompt asks for worktrees
  // under `.worktrees/` for N=1 too, so a block is expected even in the
  // degenerate case.
  const parsedWorktrees = parseWorktreesBlock(last.summary ?? "", ctx.repoRoot);
  if (Object.keys(parsedWorktrees).length > 0) {
    ps.worktrees = parsedWorktrees;
  } else {
    trace(
      `work-driver: branch ops reply carried no ## Worktrees block — N=${workstreamIds.length === 0 ? 1 : workstreamIds.length} cycle runs on the repoRoot checkout (last-resort cwd); the repo root's checkout matters until a real worktree exists`,
    );
    ps.worktrees = { default: ctx.repoRoot };
  }
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
