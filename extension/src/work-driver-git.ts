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
  },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Resolve the mainline branch name for the current repo (e.g. "main",
 * "master").
 *
 * Two-step resolution:
 *   1. `git symbolic-ref --short refs/remotes/origin/HEAD` — fast, no
 *      network, returns "origin/main" → stripped to "main" in JS.
 *   2. Fallback: `gh repo view --json defaultBranchRef` — network call,
 *      used when origin/HEAD is absent (some fetch configurations don't
 *      set it).
 *
 * Returns `{ branch: string }` on success, `{ ok: false, reason }` on
 * failure. The caller (detectMainline) is designed for use both from
 * verifyStepOutcome (via injected ctx.verifyExecFn) and from
 * restoreCheckout (injected at call site).
 *
 * NOTE on shell safety: `git symbolic-ref` takes a fixed ref with no
 * dynamic arguments. The `gh repo view` fallback takes no dynamic
 * arguments. The VerifyExecFn takes a shell string; any future caller
 * that wants to pass dynamic branch/repo names must not interpolate
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

  // 2. Fallback: gh repo view.
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
 * Restore the local checkout to an up-to-date mainline after a merge.
 *
 * Order (load-bearing):
 *   1. `git fetch origin --prune` — update remote tracking refs.
 *   2. `git checkout <mainline>` — switch to mainline.
 *   3. `git pull --ff-only origin <mainline>` — fast-forward.
 *   4. `git branch -d <mergedBranch>` — delete merged feature branch.
 *
 * Every step is idempotent: already on mainline, branch already deleted,
 * and already-up-to-date are all tolerated without error.
 *
 * `git branch -d` (lowercase) is used deliberately — on a squash-merged
 * branch the SHAs differ and -d refuses. This is expected; we report
 * but do NOT escalate to `-D`. The local branch can be cleaned later
 * with `git remote prune origin && git fetch --prune`.
 *
 * Returns an array of notes (informational messages, not errors).
 * Throws on fatal errors (git itself broken, --ff-only refusal).
 */
export async function restoreCheckout(
  repoRoot: string,
  mainline: string,
  mergedBranch: string | undefined,
  execFn: VerifyExecFn,
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

  // 2. Detect mainline (in case it was passed but verify).
  // If mainline is provided, use it directly.
  const targetMainline = mainline;
  if (!targetMainline) {
    notes.push("restoreCheckout called without mainline — skipping checkout restoration");
    return notes;
  }

  // 3. Checkout mainline. Tolerate already-on-mainline.
  try {
    const { stdout: headRef } = await execFn("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const currentBranch = headRef.trim();
    if (currentBranch !== targetMainline) {
      await execFn(`git checkout ${JSON.stringify(targetMainline)}`, {
        cwd: repoRoot,
        maxBuffer: 256 * 1024,
      });
      trace(`work-driver: checked out ${targetMainline}`);
    } else {
      trace(`work-driver: already on ${targetMainline}, skipping checkout`);
    }
  } catch (err) {
    const e = err as Error;
    // Detached HEAD or other git state — report and continue.
    notes.push(`git checkout ${targetMainline} failed: ${e.message?.slice(0, 200)}`);
  }

  // 4. Pull --ff-only. Tolerate already-up-to-date.
  try {
    await execFn(`git pull --ff-only origin ${JSON.stringify(targetMainline)}`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const e = err as Error;
    // --ff-only failure means remote advanced non-linearly.
    // Report loudly — never fall back to merge or rebase.
    notes.push(
      `git pull --ff-only origin ${targetMainline} failed (remote may have advanced non-linearly): ${e.message?.slice(0, 200)}`,
    );
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
 * Remove the cycle's scratch directory. Called only on `merged` outcome
 * — handoff/aborted preserves it for user inspection.
 *
 * Delegates to teardownWorkspaceTmp from work-driver-workspace.ts.
 * Exists here (in work-driver-git.ts) as a co-located helper alongside
 * restoreCheckout so the merged-step handler imports git helpers from
 * one place and stays under budget.
 */
export { teardownWorkspaceTmp } from "./work-driver-workspace.ts";
