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
 * #844 — the ops-fallback path previously recorded `baseSha` as
 * `git rev-parse HEAD` at repoRoot and TRUSTED it, with no verification that
 * the branch ops actually created sits on that base. The #830 incident's
 * restarted cycle is exactly this shape: a stale local branch, recorded
 * baseSha, and a diff that silently reverted merged work. Now the driver
 * resolves the freshest `origin/<mainline>` tip (best-effort fetch — the
 * mechanized path's fetch already failed, so this is often the local
 * mainline) and, after the dispatch, verifies that the resulting branch's
 * merge-base against `origin/<mainline>` equals the recorded baseSha, halting
 * with an `ops-merge-base-mismatch` cap on a mismatch. The check is
 * read-only and degrades to a trace (no halt) when the branch or remote
 * mainline ref cannot be resolved — a fetch-down fallback is the NORMAL shape
 * of this path, and "cannot verify" must not become a false halt.
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
import { detectMainline, resolveBaseSha } from "./work-driver-branch-mechanized.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { parseBranchName } from "./work-driver-diff.ts";
import { resolvedTheMainline } from "./work-driver-git.ts";
import { buildCompletionEvent, runSingleDispatch } from "./work-driver-merged.ts";
import { sliceMarkdownSection } from "./work-driver-plan.ts";
import { inlineBranchPrompt } from "./work-driver-prompts-early.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import type { WorktreeProvisionedEvent } from "./workflow-state-events-provision.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * Parse a fenced `## Worktrees` block from ops's branch reply.
 *
 * Expected format:
 *
 *   ## Worktrees
 *
 *   - task-a: /Users/janni/projects/foo/.worktrees/issue-553-task-a
 *   - task-b: /Users/janni/projects/foo/.worktrees/issue-553-task-b
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
  const execFn = ctx.verifyExecFn ?? execp;
  // #844 — resolve the freshest base BEFORE the dispatch so the prompt can
  // name the exact SHA and the post-dispatch check has a driver-computed
  // value to compare against. The fetch is best-effort: the ops-fallback path
  // fires AFTER the mechanized path's fetch already failed (or a git error
  // elsewhere), so a fetch-down run has no fresher origin ref — fall back to
  // the local mainline. `resolveBaseSha` already prefers origin/<mainline>
  // over the local ref. A fetch failure (or no remote) here must NOT throw —
  // this is the env-variance recovery path, and a fetch that is down is
  // exactly the variance it absorbs; an empty baseSha means the driver cannot
  // verify and the check below degrades to a trace.
  let driverBaseSha = "";
  try {
    const mainline = await detectMainline(execFn, ctx.repoRoot);
    // Best-effort fetch of the mainline ref; a failure degrades to the local ref.
    try {
      await execFn(`git fetch origin ${JSON.stringify(mainline)}`, {
        cwd: ctx.repoRoot,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      trace(
        `work-driver: ops-fallback fetch of origin/${mainline} failed — verifying against local refs: ${(err as Error).message?.slice(0, 160)}`,
      );
    }
    driverBaseSha = await resolveBaseSha(execFn, ctx.repoRoot, mainline);
  } catch (err) {
    trace(
      `work-driver: ops-fallback baseSha resolution failed (verification will degrade): ${(err as Error).message?.slice(0, 160)}`,
    );
  }
  let next = await runSingleDispatch(ctx, base, "branch", "ops", "ops", now, () =>
    inlineBranchPrompt(
      activeIssuesOf(base),
      workstreamIds,
      scratchDir(ctx.repoRoot, ctx.issue),
      driverBaseSha || undefined,
    ),
  );
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const reportedBranch = parseBranchName(last.summary);
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
  // #679 case 2(b) — the ops-fallback path does NOT support depends-on
  // deferred worktree creation (the ops prompt creates all worktrees at
  // baseSha, and the driver cannot defer them to runDevelop the way the
  // mechanized path can). The depends-on declarations are still in
  // pipelineState (from the plan step), so runDevelop's topological dispatch
  // order and skip-cascade logic still apply — but the dependent workstreams'
  // worktrees were already created at baseSha by the ops dispatch (NOT
  // deferred), so the dependent workstream's developer builds on baseSha
  // rather than the dependency's post-commit SHA. KNOWN LIMITATION of the
  // ops-fallback path; the mechanized path (the default) supports depends-on
  // fully. Traced here so the operator can see the limitation if the
  // ops-fallback fires on a plan with depends-on declarations.
  const dependsOnIds = Object.values(base.pipelineState.workstreams ?? {}).filter(
    (ws) => ws?.dependsOn && ws.dependsOn.length > 0,
  );
  if (dependsOnIds.length > 0) {
    trace(
      `work-driver: ops-fallback branch path with ${dependsOnIds.length} depends-on workstream(s) — deferred worktree creation is NOT supported on this path; the dependent workstreams' worktrees were created at baseSha by the ops dispatch (the mechanized path supports depends-on fully)`,
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
  // #844 — verify the branch ops actually created sits on the driver-resolved
  // base. `git merge-base <branch> origin/<mainline>` is the freshest common
  // ancestor of the branch and the remote mainline; if ops built the branch
  // off the freshly-fast-forwarded mainline, that merge-base IS the branch tip
  // (branch == base). A mismatch means ops built off a stale local ref or the
  // mainline did not actually advance — exactly the #830 shape. The check is
  // read-only and degrades to a trace (no halt) when the branch or the remote
  // mainline ref cannot be resolved: a fetch-down fallback is the NORMAL shape
  // of this path, and "cannot verify" must not become a false halt. A
  // `git merge-base` on unrelated histories (no common ancestor) exits
  // non-zero, which also routes to the halt (a branch with no shared ancestor
  // with origin/main is definitely not on the fresh base).
  let verifiedBase = "";
  if (branch) {
    try {
      const mainline = await detectMainline(execFn, ctx.repoRoot);
      let originSha = "";
      try {
        const { stdout } = await execFn(
          `git rev-parse --verify --quiet ${JSON.stringify(`origin/${mainline}`)}`,
          { cwd: ctx.repoRoot, maxBuffer: 64 * 1024 },
        );
        originSha = stdout.trim();
      } catch {
        originSha = "";
      }
      if (originSha) {
        const { stdout } = await execFn(
          `git merge-base ${JSON.stringify(`refs/heads/${branch}`)} ${JSON.stringify(originSha)}`,
          { cwd: ctx.repoRoot, maxBuffer: 64 * 1024 },
        );
        verifiedBase = stdout.trim();
      }
    } catch (err) {
      trace(
        `work-driver: ops-fallback merge-base verification failed to run (degraded, no halt): ${(err as Error).message?.slice(0, 160)}`,
      );
    }
  }
  // #844 round-2 — compare against the DRIVER-FETCHED base, not ps.baseSha.
  // `ps.baseSha` is only populated BELOW this check (from `git rev-parse HEAD`
  // at repoRoot — which is `main`, not the branch ops just created), so
  // comparing against it would (a) always be empty here and (b) halt a correct
  // branch whenever local main ≠ origin/main. `driverBaseSha` was resolved
  // above (freshest origin/<mainline> tip, local-ref fallback) for exactly this
  // comparison; a fetch-down run leaves it empty and the check degrades to a
  // trace (no false halt).
  if (verifiedBase && driverBaseSha && verifiedBase !== driverBaseSha) {
    trace(
      `work-driver: ops-fallback merge-base MISMATCH — branch ${branch} merge-base ${verifiedBase.slice(0, 8)} != driver-fetched base ${driverBaseSha.slice(0, 8)} — halting`,
    );
    return appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "ops-merge-base-mismatch",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
      evidence: `branch ${branch} sits at merge-base ${verifiedBase} with origin/<mainline>, but the driver fetched base ${driverBaseSha} — the branch was not built off the freshly-fetched base`,
    });
  }
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
    // #679 case 2(b) — the ops-fallback path does NOT support depends-on
    // deferred worktree creation: it records the worktrees the ops dispatch
    // created (all at baseSha, per the ops prompt) and cannot defer them to
    // runDevelop. The depends-on declarations are still in pipelineState
    // (from the plan step), so runDevelop's topological dispatch order and
    // skip-cascade logic still apply — but the dependent workstreams' worktrees
    // were already created at baseSha by the ops dispatch (NOT deferred), so
    // the dependent workstream's developer will build on baseSha rather than
    // the dependency's post-commit SHA. This is a KNOWN LIMITATION of the
    // ops-fallback path (documented here and in the branch prompt); the
    // mechanized path (the default) supports depends-on fully.
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
  // Emit `worktree-provisioned` events for every worktree the ops dispatch
  // created so the develop gate can name the ACTUAL cause ("ops-fallback path
  // never runs provisionWorktree") rather than giving generic hook advice.
  let stateWithProvisions: WorkState = { ...next, pipelineState: ps };
  for (const [id, cwd] of Object.entries(ps.worktrees ?? {})) {
    const provEvent: WorktreeProvisionedEvent = {
      kind: "worktree-provisioned",
      at: Date.now(),
      worktreeId: id,
      worktreePath: cwd,
      outcome: "ops-fallback-unprovisioned",
    };
    stateWithProvisions = appendEvent(stateWithProvisions, provEvent);
  }
  return stateWithProvisions;
}
