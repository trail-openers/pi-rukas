/**
 * work-driver-git — shared git helpers for /work driver steps.
 *
 * Leaf module — no dependency on any work-driver-<step>.ts handler.
 * Placed here (not in a step handler) because work-driver-commit.ts
 * already imports runSingleDispatch from work-driver-merged.ts, so
 * putting shared helpers in a step handler would create a merge →
 * verify → merged cycle.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * VerifyExecFn — the shell executor signature used by the outcome-
 * verification gate and mechanized git helpers. Takes a command string
 * (NOT an arg array) because the existing exec-based callers format
 * shell commands directly.
 *
 * SECURITY NOTE: any future extension accepting dynamic branch or repo
 * names must NOT interpolate them raw into the shell string — use
 * JSON.stringify for proper quoting, or prefer execFile-style arg arrays
 * when possible.
 */
export type VerifyExecFn = (
  cmd: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    shell?: string;
    // #1005 — argv form: when present, `cmd` is the executable and `argv`
    // its arguments, run via execFile (no shell re-parse). The coupling
    // merge's rule-3 grep uses this so planner-controlled paths arrive
    // verbatim.
    argv?: string[];
  },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Resolve the mainline branch name for the current repo (e.g. "main",
 * "master").
 *
 * Two-step resolution:
 *   1. `git symbolic-ref --short refs/remotes/origin/HEAD` — fast, no
 *      network, returns "origin/main" → stripped to "main" in JS.
 *   2. Fallback: the forge adapter's `repoSettings()` (the network call
 *      behind the old `gh repo view --json defaultBranchRef`), used when
 *      origin/HEAD is absent (some fetch configurations don't set it).
 *
 * Returns `{ branch: string }` on success, `{ ok: false, reason }` on
 * failure. The caller (detectMainline) is designed for use both from
 * verifyStepOutcome (via injected ctx.verifyExecFn) and from
 * restoreCheckout (injected at call site).
 *
 * NOTE on shell safety: `git symbolic-ref` takes a fixed ref with no
 * dynamic arguments. The VerifyExecFn takes a shell string; any future
 * caller that wants to pass dynamic branch/repo names must not interpolate
 * them raw — JSON.stringify for quoting or prefer execFile-style arrays.
 */
export async function detectMainline(
  repoRoot: string,
  execFn: VerifyExecFn,
): Promise<{ branch: string } | { ok: false; reason: string }> {
  // 1. git symbolic-ref — no network, instant.
  try {
    const { stdout } = await execFn("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const ref = stdout.trim();
    if (ref) {
      // Returns "origin/main" — strip the leading origin/.
      const branch = ref.startsWith("origin/") ? ref.slice(7) : ref;
      if (branch) return { branch };
    }
  } catch {
    // refs/remotes/origin/HEAD may be absent; fall through.
  }

  // 2. Fallback: `gh repo view` — the raw-JSON call is kept rather than
  //    routed through the forge adapter on purpose: the tests inject a
  //    `git symbolic-ref`-answering fake that answers nothing else, and
  //    the forge's `repoSettings()` command shape is not what those fakes
  //    expect. The adapter is the S4 seam for PR operations; this
  //    mainline probe is a git-side call with a `gh` fallback.
  try {
    const { stdout } = await execFn(
      "gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'",
      { cwd: repoRoot, maxBuffer: 64 * 1024 },
    );
    const branch = stdout.trim();
    if (branch) return { branch };
  } catch {
    // Both methods failed.
  }

  return {
    ok: false,
    reason: "could not resolve mainline branch: both git symbolic-ref and gh repo view failed",
  };
}

/**
 * Restore the operator's checkout after a merge.
 *
 * #1093 — the restore target is the cycle-start ref (`startRef`: the branch
 * name, or the SHA when the operator was detached), NOT mainline. A cycle
 * that started on `feature/X` ends with repoRoot on `feature/X`. When no
 * startRef was recorded (pre-#1093 state), the target is mainline, as before.
 *
 * Order (load-bearing):
 *   1. `git fetch origin --prune` — update remote tracking refs.
 *   2. `git checkout <target>` — switch to the restore target. Never forced:
 *      a refusal (e.g. a dirty tree) is a note carrying the exact command.
 *   3. `git pull --ff-only origin <mainline>` — fast-forward. Only when the
 *      target IS mainline; pulling mainline into another branch is wrong.
 *   4. `git branch -d <mergedBranch>` — delete merged feature branch.
 *
 * Every step is idempotent: already on the target, branch already deleted,
 * and already-up-to-date are all tolerated without error.
 *
 * `mainline` may be undefined when detection failed; a `startRef` still
 * restores the operator's checkout (without the pull).
 *
 * `git branch -d` (lowercase) is used deliberately — on a squash-merged
 * branch the SHAs differ and -d refuses. This is expected; we report
 * but do NOT escalate to `-D` (the PR body says the branch is gone, and
 * force-deleting locally would hide that the refusal is the normal
 * outcome). The leftover is removed later, by hand: `git branch -D
 * <mergedBranch>`. An automated sweep is out of scope for this function
 * because a naive `[gone]`/`--merged` sweep would also delete local
 * branches that have no upstream at all.
 *
 * Returns an array of notes (informational messages, not errors).
 * Every step is individually caught: a fetch failure, a checkout failure,
 * a `--ff-only` refusal, and a `branch -d` refusal all become notes,
 * never exceptions. The only path that propagates is an unexpected throw
 * from the caller-provided execFn itself (e.g. an exec option rejection).
 */
export async function restoreCheckout(
  repoRoot: string,
  mainline: string | undefined,
  mergedBranch: string | undefined,
  execFn: VerifyExecFn,
  startRef?: string,
): Promise<string[]> {
  const notes: string[] = [];

  // 1. Fetch origin --prune.
  try {
    await execFn("git fetch origin --prune", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    notes.push(`git fetch origin --prune failed: ${(err as Error).message?.slice(0, 200)}`);
    // Continue — subsequent steps may still work with stale refs.
  }

  // 2. The restore target: the cycle-start ref when recorded, else mainline.
  const target = startRef ?? mainline;
  if (!target) {
    notes.push(
      "restoreCheckout called without mainline or startRef — skipping checkout restoration",
    );
    return notes;
  }
  const onMainline = target === mainline;
  const checkoutCmd = `git checkout ${JSON.stringify(target)}`;

  // 3. Checkout the target. Tolerate already-there. Never forced.
  try {
    const { stdout: headRef } = await execFn("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const currentBranch = headRef.trim();
    if (currentBranch !== target) {
      await execFn(checkoutCmd, { cwd: repoRoot, maxBuffer: 256 * 1024 });
      trace(`work-driver: checked out ${target}`);
    } else {
      trace(`work-driver: already on ${target}, skipping checkout`);
    }
  } catch (err) {
    const e = err as Error;
    // Dirty tree, detached HEAD or other git state — report with the exact
    // command the operator runs. The tree is left as it is (#1093).
    notes.push(
      `git checkout ${target} failed (repoRoot was NOT restored): ${e.message?.slice(0, 200)}; run \`${checkoutCmd}\` at the repo root once the tree is clean`,
    );
  }

  // 4. Pull --ff-only, only when the target is mainline. Tolerate
  // already-up-to-date.
  if (onMainline && mainline) {
    try {
      await execFn(`git pull --ff-only origin ${JSON.stringify(mainline)}`, {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      const e = err as Error;
      // --ff-only failure means remote advanced non-linearly.
      // Report loudly — never fall back to merge or rebase.
      notes.push(
        `git pull --ff-only origin ${mainline} failed (remote may have advanced non-linearly): ${e.message?.slice(0, 200)}`,
      );
    }
  }

  // 5. Delete merged feature branch. Tolerate absent branch.
  if (mergedBranch) {
    try {
      await execFn(`git branch -d ${JSON.stringify(mergedBranch)}`, {
        cwd: repoRoot,
        maxBuffer: 64 * 1024,
      });
      trace(`work-driver: deleted branch ${mergedBranch}`);
    } catch (err) {
      // -d refuses on squash-merged branches (SHA mismatch). Expected.
      // Also tolerates already-deleted branches.
      const e = err as Error;
      notes.push(
        `git branch -d ${mergedBranch} refused (expected after squash merge or if branch already deleted): ${e.message?.slice(0, 200)}`,
      );
    }
  }

  return notes;
}

/**
 * #1093 — the ref repoRoot holds right now: the branch name, or the commit SHA
 * when detached. Throws when neither resolves (no repo, no commits) so the
 * caller decides what an unknown start means.
 */
export async function captureCycleStartRef(
  execFn: VerifyExecFn,
  repoRoot: string,
): Promise<string> {
  try {
    const { stdout } = await execFn("git symbolic-ref --quiet --short HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    // Detached HEAD: symbolic-ref refuses. Fall through to the SHA.
  }
  const { stdout } = await execFn("git rev-parse HEAD", {
    cwd: repoRoot,
    maxBuffer: 64 * 1024,
  });
  return stdout.trim();
}

/**
 * #1093 — stamp `pipelineState.startRef` with the checkout the cycle found.
 * Written ONCE: a resumed cycle keeps the ref its first run captured, because
 * by then repoRoot may already sit on the feature branch. Capture failure is
 * traced and leaves the state without a ref (restores fall back to the
 * pre-#1093 targets) rather than failing the branch step.
 */
export async function recordCycleStartRef(
  execFn: VerifyExecFn,
  repoRoot: string,
  state: WorkState,
): Promise<WorkState> {
  if (state.pipelineState.startRef) return state;
  try {
    const startRef = await captureCycleStartRef(execFn, repoRoot);
    trace(`work-driver: cycle started on ${startRef}`);
    return { ...state, pipelineState: { ...state.pipelineState, startRef } };
  } catch (err) {
    trace(
      `work-driver: could not record the cycle start ref: ${(err as Error).message?.slice(0, 160)}`,
    );
    return state;
  }
}

/**
 * Remove the cycle's scratch directory. Called only on `merged` outcome
 * — handoff/aborted preserves it for user inspection.
 *
 * Delegates to teardownWorkspaceTmp from work-driver-workspace.ts.
 * Exists here (in work-driver-git.ts) as a co-located helper alongside
 * restoreCheckout so the merged-step handler imports git helpers from
 * one place and stays under budget.
 */
export { teardownWorkspaceTmp } from "./work-driver-workspace.ts";

/**
 * Did the branch step resolve the mainline as this cycle's branch?
 *
 * `ps.branchName` becomes the integration branch: `integrate()` runs
 * `git checkout -B <branch> <baseSha>` and `git push -u origin <branch>`
 * against it. The ops-fallback path reads it from wherever `repoRoot`'s HEAD
 * happens to point, so an ops child that creates the branch and worktrees and
 * then returns `repoRoot` to the mainline hands the cycle `main` — and a grep
 * across the write path found no mainline check anywhere.
 *
 * An unreadable mainline means "not proven to be the mainline", so the cycle
 * proceeds. That is the right direction here: this guards one specific mistake,
 * and a repo whose default branch cannot be resolved is normal enough that
 * halting on it would cost more than the risk it removes.
 */
export async function resolvedTheMainline(
  repoRoot: string,
  execFn: VerifyExecFn,
  branch: string | undefined,
): Promise<boolean> {
  if (!branch) return false;
  const mainline = await detectMainline(repoRoot, execFn);
  return "branch" in mainline && mainline.branch === branch;
}
