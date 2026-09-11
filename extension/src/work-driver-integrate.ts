/**
 * work-driver-integrate — #287 Part B: the ONLY path that writes to repoRoot.
 * Under always-worktree, development happens in `.worktrees/issue-<N>-<id>` and
 * repoRoot is an integration point. Cherry-pick: work-driver-cherry-pick.ts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { orchestrateCherryPick } from "./work-driver-cherry-pick.ts";
import { stagePorcelainPaths } from "./work-driver-stage.ts";
import type { WorkState } from "./workflow-state-schema.ts";
import type { ExecFn } from "./worktree.ts";
import { sweepBranchHolders } from "./worktree.ts";

/**
 * #289 — serialise every operation that touches repoRoot's checkout, index
 * or HEAD. Two layers: the promise chain (fast path within a process) and
 * the lockfile (cross-process backstop). See test-integration-lock.ts.
 */
let integrationChain: Promise<unknown> = Promise.resolve();

/** How long a lockfile may sit before it is presumed abandoned. */
const LOCK_STALE_MS = 30 * 60 * 1000;

function lockPath(repoRoot: string): string {
  return path.join(repoRoot, ".git", "pi-rukas-integration.lock");
}

async function acquireLockfile(repoRoot: string): Promise<() => Promise<void>> {
  const file = lockPath(repoRoot);
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      // `wx` is O_EXCL: the create itself is the atomic test-and-set.
      const fh = await fs.open(file, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      return async () => {
        await fs.rm(file, { force: true }).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Cannot create the lock at all (read-only .git, permissions).
        // Fail OPEN: the in-process chain still serialises this process.
        trace(`integration-lock: lockfile unavailable, continuing: ${(err as Error).message}`);
        return async () => undefined;
      }
      // Held. Sweep it if the holder is long gone, otherwise wait.
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as { at?: number };
        if (typeof raw.at === "number" && Date.now() - raw.at > LOCK_STALE_MS) {
          trace("integration-lock: sweeping a stale lockfile");
          await fs.rm(file, { force: true }).catch(() => undefined);
          continue;
        }
      } catch {
        // Unreadable/corrupt lock — treat as stale rather than deadlocking.
        await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        trace("integration-lock: waited past the stale window, proceeding");
        return async () => undefined;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Run `fn` holding the integration lock. Never inherits a prior rejection. */
export function withIntegrationLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const run = integrationChain.then(
    () => guarded(repoRoot, fn),
    () => guarded(repoRoot, fn),
  );
  integrationChain = run.catch(() => undefined);
  return run;
}

async function guarded<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLockfile(repoRoot);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Test seam: reset the in-process chain between fixtures. */
export function __resetIntegrationLock(): void {
  integrationChain = Promise.resolve();
}

/** Issue title from the explore step's cached artifact; undefined on miss. */
export async function cachedIssueTitle(state: WorkState): Promise<string | undefined> {
  const artifact = state.pipelineState.issueBodyArtifact;
  if (!artifact) return undefined;
  try {
    const body = await fs.readFile(artifact, "utf8");
    return body.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export interface IntegrateOpts {
  repoRoot: string;
  branchName: string;
  /** Commit-ish the branch is created at. Required for mode "create". */
  baseSha?: string;
  worktrees: Record<string, string>;
  /** Where conflict patches are preserved for the operator. */
  scratchDir: string;
  commitTitle: string;
  commitBody: string;
  mode: "create" | "followup";
  /**
   * Fail if ANY workstream produced no diff, rather than consolidating the
   * rest. commit-pr sets this: a silently-skipped workstream is how
   * /work 577 shipped 1 of 3 slices and closed the issue with the root fix
   * missing (v0.12.13). Lens-fix leaves it off — a fix round legitimately
   * touches only the worktree that had findings.
   */
  requireAllNonEmpty?: boolean;
  /**
   * #453 — pre-existing commit SHAs from a prior attempt (resume).
   * Used by the cherry-pick path to skip workstreams already applied.
   */
  commitShas?: Record<string, string>;
  /**
   * The project's verify command, run against the CONSOLIDATED tree between
   * the commit and the push. Integration is the first place the combination
   * is compiled — every prior gate saw one workstream in isolation. Omitted
   * (or absent from the project) means the check is skipped, as before.
   */
  verifyCmd?: string;
  /** Executor for `verifyCmd`. Defaults to `execFn`; tests inject. */
  verifyExecFn?: ExecFn;
  /** Wall-clock for `verifyCmd`. */
  verifyTimeoutMs?: number;
}

/**
 * #492 — worktrees that produced no diff, keyed by id → worktree path.
 * The path IS the git evidence an operator inspects (`git -C <path> status`).
 */
export type NoDiff = Record<string, string>;

export type IntegrateResult =
  | {
      ok: true;
      workstreams: string[];
      empty: false;
      /** #492 — worktrees that were clean at stage time (the fixer/developer
       *  produced no diff there). Set only when at least one worktree was
       *  clean, so a caller can tell "this one wrote nothing" apart from the
       *  workstreams that did ship. */
      noDiff?: NoDiff;
      /** #453 — cherry-picked commit SHAs, keyed by workstream id. Set when
       *  the cherry-pick path ran (one or more worktrees had commits). */
      commitShas?: Record<string, string>;
    }
  /** Nothing to integrate — every worktree was clean. Not an error. #492. */
  | { ok: true; workstreams: []; empty: true; noDiff: NoDiff }
  | {
      ok: false;
      reason: string;
      conflictPatch?: string;
      /** #492 — worktrees that produced no diff (for handoff context). */
      noDiff?: NoDiff;
      /** #539 — structured failure discriminator. Cause readers MUST read this, never re-parse `reason`. */
      failure?: "dirty-repoRoot" | "apply" | "verify";
      /**
       * #654 task-c — verbatim porcelain lines from the dirty preflight.
       * Set only on dirty-repoRoot failure; the caller parks with THIS,
       * not a bare refusal string.
       */
      porcelain?: string[];
    };

/**
 * Consolidate every worktree onto the feature branch at repoRoot.
 * Fails rather than forces at every step. The dirty-repoRoot preflight runs
 * before `checkout -B` so operator residue is never silently carried onto
 * the feature branch (incident #602).
 */
export async function integrate(execFn: ExecFn, opts: IntegrateOpts): Promise<IntegrateResult> {
  const { repoRoot, branchName, worktrees, mode } = opts;
  const ids = Object.keys(worktrees);
  // Where repoRoot was before we touched it. A failed integration must put it
  // back: the previous code returned from inside the apply loop with the
  // checkout already switched and 0..N-1 workstreams already in the index, so
  // the operator found a half-applied branch; the NEXT cycle's dirty preflight
  // would refuse to run at all.
  let originalRef: string | undefined;
  const restoreRoot = async () => {
    if (!originalRef) return;
    try {
      await execFn("git reset --hard", { cwd: repoRoot, maxBuffer: 256 * 1024 });
      await execFn(`git checkout --force ${JSON.stringify(originalRef)}`, {
        cwd: repoRoot,
        maxBuffer: 256 * 1024,
      });
    } catch (err) {
      trace(
        `work-driver: integrate — could not restore repoRoot to ${originalRef}: ${(err as Error).message?.slice(0, 160)}`,
      );
    }
  };
  try {
    // 1. Preflight: repoRoot must be clean before we touch its checkout.
    // `.worktrees/` is driver scaffolding, not operator residue (backstop for
    // when .git/info/exclude write failed).
    const { stdout: rootStatus } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const rootDirt = rootStatus
      .split("\n")
      .filter((l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l));
    if (rootDirt.length > 0) {
      const files = rootDirt
        .slice(0, 10)
        .map((l) => l.slice(3))
        .join(", ");
      return {
        ok: false,
        failure: "dirty-repoRoot",
        reason: `repo root has uncommitted changes, refusing to integrate onto ${branchName}: ${files}. Commit, stash, or discard them — integration would otherwise sweep them into the PR.`,
        porcelain: rootDirt,
      };
    }

    // 2. Put repoRoot on the integration branch, remembering where it was.
    //    Detached HEAD has no symbolic ref — fall back to the raw sha.
    originalRef = await execFn("git symbolic-ref --quiet --short HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    })
      .then((r) => r.stdout.trim())
      .catch(async () =>
        (await execFn("git rev-parse HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 })).stdout.trim(),
      );
    if (mode === "create") {
      if (!opts.baseSha) return { ok: false, reason: "baseSha is required to create a branch" };
      await execFn(
        `git checkout -B ${JSON.stringify(branchName)} ${JSON.stringify(opts.baseSha)}`,
        { cwd: repoRoot, maxBuffer: 256 * 1024 },
      );
    } else {
      // #654 — a clean worktree holding the branch blocks the checkout
      // ("fatal: '<branch>' is already used by worktree at '…'"); a dirty
      // one throws DirtyWorktreeError. Runs under withIntegrationLock.
      await sweepBranchHolders(execFn, repoRoot, branchName);
      await execFn(`git checkout ${JSON.stringify(branchName)}`, {
        cwd: repoRoot,
        maxBuffer: 256 * 1024,
      });
    }

    // 3. Orchestrated cherry-pick + patch fallback (work-driver-cherry-pick.ts).
    //    The patch-fallback rebases a followup-mode lens-fix patch onto the
    //    branch's CURRENT head before applying it (#654 task-b).
    const orchResult = await orchestrateCherryPick(execFn, {
      repoRoot,
      branchName,
      worktrees: { ids, worktrees, commitShas: opts.commitShas ?? {} },
      baseSha: opts.baseSha,
      scratchDir: opts.scratchDir,
      requireAllNonEmpty: opts.requireAllNonEmpty,
    });

    // Handle cherry-pick conflict — caller must abort and restore branch.
    if (orchResult._conflict === "conflict") {
      await restoreRoot();
      return {
        ok: false,
        failure: "apply",
        reason: `cherry-pick conflict — the batch was aborted and repoRoot was restored to ${originalRef}.`,
      };
    }

    // Handle requireAllNonEmpty failure for a no-diff workstream.
    if (orchResult._noDiffRequireFail !== undefined) {
      const id = orchResult._noDiffRequireFail;
      const wt = worktrees[id];
      await restoreRoot();
      return {
        ok: false,
        reason: `worktree '${id}' has no uncommitted work — nothing to consolidate.`,
        noDiff: Object.keys(orchResult.noDiff).length > 0 ? orchResult.noDiff : undefined,
      };
    }

    // Handle patch-apply failure.
    if (orchResult._applyConflict !== undefined) {
      const { id, reason: applyReason, patchFile } = orchResult._applyConflict;
      const emptySlice = orchResult.emptyWorkstreams.slice(
        orchResult.emptyWorkstreams.indexOf(id) + 1,
      );
      await restoreRoot();
      const skipped = emptySlice.length > 0 ? ` Not attempted: ${emptySlice.join(", ")}.` : "";
      return {
        ok: false,
        failure: "apply",
        reason:
          `git apply failed for workstream '${id}': ${applyReason}.` +
          `${skipped} repoRoot restored to ${originalRef}.`,
        conflictPatch: patchFile,
      };
    }

    const cherryApplied = orchResult.cherryApplied;
    const cherryPickShas = orchResult.cherryPickShas;
    const patchApplied = orchResult.patchApplied;
    const noDiff = orchResult.noDiff;

    // Commit staged changes (cherry-pick uses --no-commit; patch-apply is a no-op).
    const { stdout: hasStaged } = await execFn("git diff --cached --name-only", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (hasStaged.trim()) {
      await execFn(
        `git commit -m ${JSON.stringify(opts.commitTitle)} -m ${JSON.stringify(opts.commitBody)}`,
        { cwd: repoRoot, maxBuffer: 256 * 1024 },
      );
    }

    // Determine which workstreams actually produced output.
    const appliedWorkstreams = cherryApplied.length > 0 ? cherryApplied : patchApplied;
    // Check if cherry-picked workstreams were all no-ops.
    if (opts.baseSha) {
      const { stdout: headAhead } = await execFn(
        `git rev-list --count ${JSON.stringify(opts.baseSha)}..HEAD`,
        { cwd: repoRoot, maxBuffer: 64 * 1024 },
      );
      const ahead = Number.parseInt(headAhead.trim(), 10);
      if (!Number.isFinite(ahead) || ahead === 0) {
        // No commits ahead — every cherry-pick was a no-op or there was
        // nothing to do. Return empty rather than a spurious success.
        return { ok: true, workstreams: [], empty: true, noDiff };
      }
    } else {
      // No baseSha — check if there are staged changes (patch fallback).
      if (appliedWorkstreams.length === 0) {
        const { stdout: hasStaged2 } = await execFn("git diff --cached --name-only", {
          cwd: repoRoot,
          maxBuffer: 64 * 1024,
        });
        if (!hasStaged2.trim()) {
          return { ok: true, workstreams: [], empty: true, noDiff };
        }
      }
    }

    // 4. Verify the CONSOLIDATED tree before it becomes a PR. See `verifyCmd`.
    //    Rolling back on failure is safe: the worktrees still hold every
    //    workstream's commit — they are only advanced past it after a
    //    successful push, below.
    if (opts.verifyCmd) {
      const verifyExec = opts.verifyExecFn ?? execFn;
      let failure: string | undefined;
      try {
        await verifyExec(opts.verifyCmd, {
          cwd: repoRoot,
          maxBuffer: 8 * 1024 * 1024,
          timeout: opts.verifyTimeoutMs,
        });
      } catch (err) {
        const e = err as Error & { stderr?: string; stdout?: string };
        failure = (e.stderr || e.stdout || e.message || "").toString().trim();
      }
      if (failure !== undefined) {
        await restoreRoot();
        return {
          ok: false,
          failure: "verify",
          reason:
            `the consolidated tree fails the project's verify command (\`${opts.verifyCmd}\`), so it was not pushed. ` +
            `Each workstream passed alone; the combination does not. Tail: ${failure.slice(-600)}`,
        };
      }
    }

    // 5. Push.
    await execFn(`git push -u origin ${JSON.stringify(branchName)}`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });

    // Advance each cherry-picked worktree to the new HEAD — without this the
    // worktree keeps the developer's commit and the NEXT integration would
    // re-cherry-pick the same SHA (fails or creates a duplicate).
    const { stdout: newHead } = await execFn("git rev-parse HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const headSha = newHead.trim();
    if (headSha) {
      for (const id of appliedWorkstreams) {
        const wt = worktrees[id];
        if (!wt) continue;
        await execFn(`git reset --hard ${JSON.stringify(headSha)}`, {
          cwd: wt,
          maxBuffer: 256 * 1024,
        }).catch((err) =>
          trace(
            `work-driver: integrate — could not advance worktree '${id}' to ${headSha.slice(0, 8)}: ${(err as Error).message?.slice(0, 160)}`,
          ),
        );
      }
    }
    return {
      ok: true,
      workstreams: appliedWorkstreams,
      empty: false,
      noDiff: Object.keys(noDiff).length > 0 ? noDiff : undefined,
      commitShas: Object.keys(cherryPickShas).length > 0 ? cherryPickShas : undefined,
    };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    // Anything that threw mid-integration leaves the same half-applied tree a
    // conflict does, so it gets the same treatment.
    await restoreRoot();
    return {
      ok: false,
      reason: (e.stderr ?? e.message ?? "unknown error").toString().trim().slice(0, 300),
    };
  }
}

/**
 * #654 task-c — the dirty-repoRoot preflight as a reusable, single
 * implementation (the issue's "single implementation, not a copy").
 * Same filtering rule as `integrate()` — `.worktrees/` is driver scaffolding,
 * not operator residue — so the two cannot drift.
 * Returns `undefined` when repoRoot is clean (the common case).
 */
export async function readDirtyPorcelain(
  execFn: ExecFn,
  repoRoot: string,
): Promise<string[] | undefined> {
  const { stdout } = await execFn("git status --porcelain", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  const dirt = stdout.split("\n").filter((l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l));
  return dirt.length > 0 ? dirt : undefined;
}

/**
 * #654 task-c — the shared restore convention for the repoRoot checkout.
 * Stash tracked dirt so a retry can integrate onto a clean tree, then pop it
 * back so the operator's work is never lost. Untracked-only dirt is not
 * safely stashable — the caller parks with the porcelain in evidence instead.
 */
export async function restoreRepoRoot(
  execFn: ExecFn,
  repoRoot: string,
  porcelain: string[],
): Promise<{ restored: boolean; reason?: string }> {
  if (!porcelain.some((l) => l.trim().length > 0 && !l.startsWith("??"))) {
    return {
      restored: false,
      reason:
        "repo root has only untracked files — stashing is not safe for untracked work, so the cycle parks rather than risk dropping it",
    };
  }
  try {
    await execFn("git stash push -m pi-rukas-lens-fix-restore", {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
  } catch (err) {
    return {
      restored: false,
      reason: `git stash failed: ${(err as Error).message?.slice(0, 200)}`,
    };
  }
  try {
    await execFn("git stash pop", { cwd: repoRoot, maxBuffer: 256 * 1024 });
  } catch (err) {
    return {
      restored: false,
      reason: `git stash pop failed — the operator's work is in the stash (git stash list): ${(err as Error).message?.slice(0, 200)}`,
    };
  }
  return { restored: true };
}
