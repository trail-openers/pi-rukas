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
import { execp } from "./exec.ts";
// #1387 — the mainline lookup lives in the neutral leaf `mainline.ts` so the
// review ledger path does not import this module for it. Imported (not only
// re-exported) because `resolvedTheMainline` below calls it; every driver
// caller and smoke test still resolves the symbols from this module unchanged.
import { detectMainline, resolveMainline } from "./mainline.ts";
export { type MainlineResult, detectMainline, resolveMainline } from "./mainline.ts";
import { trace } from "./trace.ts";
import { runNetGit } from "./work-driver-net-git.ts";
import { restoreRefProblem, restoreRootToRef } from "./work-driver-restore.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * VerifyExecFn — the shell executor signature used by the outcome-
 * verification gate and mechanized git helpers. Takes a command string
 * (NOT an arg array) because the existing exec-based callers format
 * shell commands directly.
 *
 * SECURITY NOTE: any extension accepting dynamic branch or repo names must
 * NOT interpolate them raw into the shell string. Prefer execFile-style arg
 * arrays (`opts.argv`), as the restore path (#1093) does throughout, with refs
 * validated by restoreRefProblem. JSON.stringify is NOT a safe substitute: it
 * leaves `$` and backtick live inside the double quotes that /bin/sh expands.
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
    // #1095 / #1414 r3 — kill the whole process group on timeout or overflow.
    // Declared here because `execp` satisfies this signature (asserted below)
    // and every executor that honours `argv` routes through the same shared
    // executor, which implements it. Without it a caller cannot ASK for a
    // group kill: the checkpoint's typecheck needs one, because `bun x tsc`
    // spawns a `tsc` grandchild that a plain timeout leaves compiling.
    killGroup?: boolean;
  },
) => Promise<{ stdout: string; stderr?: string }>;

// Compile-time seam check: the shared executor must satisfy VerifyExecFn, so an
// argv-aware executor can never be swapped for one that silently drops `argv`.
void (execp satisfies VerifyExecFn);

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
export async function restoreCheckout(opts: {
  repoRoot: string;
  mainline: string | undefined;
  mergedBranch: string | undefined;
  execFn: VerifyExecFn;
  /** The cycle-start ref (#1093); absent for pre-#1093 state. */
  startRef?: string;
  /**
   * #1362 — the cycle's `.pi/dirty-root-exempt` list and its cycle-start
   * baseline. Together they decide which untracked files the restore claim
   * names; the built-in scaffolding exclusions are unchanged.
   */
  dirtyRootExempt?: readonly string[];
  dirtyRootExemptBaseline?: readonly string[];
}): Promise<string[]> {
  const {
    repoRoot,
    mainline,
    mergedBranch,
    execFn,
    startRef,
    dirtyRootExempt,
    dirtyRootExemptBaseline,
  } = opts;
  const notes: string[] = [];

  // 1. Fetch origin --prune. Every git command here is argv-form (#1093): a
  // ref is data, never shell text.
  try {
    // #1095 — network call: non-interactive env + bounded wait.
    await runNetGit(execFn, "git", {
      cwd: repoRoot,
      argv: ["fetch", "origin", "--prune"],
    });
  } catch (err) {
    notes.push(`git fetch origin --prune failed: ${(err as Error).message?.slice(0, 200)}`);
    // Continue — subsequent steps may still work with stale refs. #1095: a
    // timeout is also a note, carrying "network git timed out" as its named
    // cause. Not a thrown step failure: the merge has already succeeded, and a
    // halt here routes a merged PR to handoff (see work-driver-events.ts).
  }

  // 2. The restore target — the ONE rule, shared with the handoff path.
  const resolved = await resolveRestoreTarget({
    execFn,
    repoRoot,
    mainline,
    startRef,
  });
  notes.push(...resolved.notes);
  const target = resolved.target;
  if (!target) return notes;
  const onMainline = target === mainline;

  // 3. Checkout the target via the single non-forcing restore primitive.
  // Tolerates already-there; a refusal (dirty tree, detached HEAD) leaves the
  // tree as it is and the note carries the exact command to run by hand.
  const restore = await restoreRootToRef(execFn, {
    repoRoot,
    ref: target,
    label: "merged",
    dirtyRootExempt,
    dirtyRootExemptBaseline,
  });
  if (!restore.checkedOut) {
    notes.push(`repoRoot was NOT restored to ${target}: ${restore.detail ?? "unknown error"}`);
    // A refused checkout performs no further git mutation: no pull, and no
    // branch deletion (the operator's tree is still on the merged branch).
    notes.push("git pull and git branch -d skipped: the checkout was refused");
    return notes;
  }
  if (!restore.restored) {
    // HEAD has moved off the merged branch, so the deletion below is still
    // safe (-d refuses unmerged work). The pull is not: it would run on a
    // tree with tracked changes left behind.
    notes.push(
      `repoRoot is on ${target} but was NOT verified clean: ${restore.detail ?? "unknown error"}`,
    );
  }

  // 4. Pull --ff-only, only when the tree is verified clean AND the target is
  // mainline. Tolerate already-up-to-date.
  if (restore.restored && onMainline && mainline) {
    try {
      // #1095 — network call: non-interactive env + bounded wait.
      await runNetGit(execFn, "git", {
        cwd: repoRoot,
        argv: ["pull", "--ff-only", "origin", mainline],
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

  // 5. Delete merged feature branch. Tolerate absent branch. `--` ends option
  // parsing, so a branch name can never be read as a flag.
  if (mergedBranch) {
    const problem = await restoreRefProblem(execFn, repoRoot, mergedBranch);
    if (problem !== undefined) {
      notes.push(`git branch -d skipped: ${problem}`);
    } else {
      try {
        await execFn("git", {
          cwd: repoRoot,
          maxBuffer: 64 * 1024,
          argv: ["branch", "-d", "--", mergedBranch],
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
  }

  return notes;
}

/**
 * #1093 — THE restore-target rule, shared by restoreCheckout (merged step)
 * and the handoff consolidation path. The cycle-start ref (`startRef`) when it
 * was recorded and is usable; otherwise mainline, with a note saying why. The
 * ref is validated here, once. `target` is undefined when neither is usable:
 * the caller then restores nothing rather than guessing a checkout (and never
 * the branch the cycle left checked out).
 */
export async function resolveRestoreTarget(opts: {
  execFn: VerifyExecFn;
  repoRoot: string;
  mainline: string | undefined;
  startRef: string | undefined;
}): Promise<{ target: string | undefined; notes: string[] }> {
  const { execFn, repoRoot, mainline, startRef } = opts;
  const toMainline = mainline ? `restored to ${mainline}` : "no mainline to restore to";
  if (startRef === undefined) {
    return {
      target: mainline,
      notes: [`start ref was not recorded; ${toMainline}`],
    };
  }
  const problem = await restoreRefProblem(execFn, repoRoot, startRef);
  if (problem === undefined) return { target: startRef, notes: [] };
  return {
    target: mainline,
    notes: [`cycle start ref not used (${problem}); ${toMainline}`],
  };
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
    // The full ref, not `--short`: a tag sharing the branch's short name makes
    // `--short` emit `heads/<name>`, which is not a name a restore can check out.
    const { stdout } = await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      argv: ["symbolic-ref", "--quiet", "HEAD"],
    });
    const full = stdout.trim();
    if (full.startsWith("refs/heads/")) return full.slice("refs/heads/".length);
  } catch {
    // Detached HEAD: symbolic-ref refuses. Fall through to the SHA.
  }
  const { stdout } = await execFn("git", {
    cwd: repoRoot,
    maxBuffer: 64 * 1024,
    argv: ["rev-parse", "HEAD"],
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
const CAPTURE_FAILED = "could not record the cycle start ref";

/** Did an earlier run fail to capture the start ref? (#1093 — see recordCycleStartRef.) */
export function hasCaptureFailure(state: WorkState): boolean {
  return (state.pipelineState.plumbReports ?? []).some((r) => r.body.startsWith(CAPTURE_FAILED));
}

/**
 * #1093 — the operator's checkout, read once per /work invocation by the queue
 * before any group starts (`runWorkQueue`). Undefined when the read fails; the
 * per-cycle stamp then falls back to its own locked capture.
 */
export async function captureInvocationStartRef(repoRoot: string): Promise<string | undefined> {
  // argv-aware executor: promisify(exec) would run a bare `git` and read its usage text.
  return captureCycleStartRef(execp, repoRoot).catch(() => undefined);
}

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
    const msg = (err as Error).message?.slice(0, 160);
    trace(`work-driver: could not record the cycle start ref: ${msg}`);
    // Surfaced in the handoff (plumbReports), not only traced: without a ref the
    // restore falls back to mainline, which the operator must be told about.
    return {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        plumbReports: [
          ...(state.pipelineState.plumbReports ?? []),
          {
            step: "branch",
            role: "driver",
            body: `${CAPTURE_FAILED} (${msg}); the checkout restore falls back to mainline`,
            at: Date.now(),
          },
        ],
      },
    };
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
  return mainline.ok && mainline.branch === branch;
}
