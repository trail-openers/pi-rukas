/** #287 Part B — the ONLY path that writes to repoRoot. */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { orchestrateCherryPick } from "./work-driver-cherry-pick.ts";
import type { ConsolidationCompleteness } from "./work-driver-completeness.ts";
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";
import { stagePorcelainPaths } from "./work-driver-stage.ts";
import type { WorkState } from "./workflow-state-schema.ts";
import type { ExecFn } from "./worktree.ts";
import { sweepBranchHolders } from "./worktree.ts";
// Re-exported for backward compatibility (callers imported these from
// work-driver-integrate.ts pre-#750; the implementations now live in
// work-driver-preflight.ts).
export { readDirtyPorcelain, restoreRepoRoot } from "./work-driver-preflight.ts";

let integrationChain: Promise<unknown> = Promise.resolve();
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
  /** #577 — fail if ANY workstream produced no diff (commit-pr sets this). */
  requireAllNonEmpty?: boolean;
  /** #453 — pre-existing commit SHAs from a prior attempt (resume). */
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

/** #492 — worktrees that produced no diff, keyed by id → worktree path. */
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
      commitShas?: Record<string, string>;
      completeness?: ConsolidationCompleteness;
    }
  /** Nothing to integrate — every worktree was clean. Not an error. #492. */
  | {
      ok: true;
      workstreams: [];
      empty: true;
      noDiff: NoDiff;
      /** #749 — empty because every workstream's work was already on the
       *  branch (tree-hash dedup skip), not because nothing was produced. */
      skippedAlreadyOnBranch?: string[];
    }
  | {
      ok: false;
      reason: string;
      conflictPatch?: string;
      /** #492 — worktrees that produced no diff (for handoff context). */
      noDiff?: NoDiff;
      /** #539 — structured failure discriminator. Cause readers MUST read this, never re-parse `reason`. */
      failure?: "dirty-repoRoot" | "apply" | "verify";
      /** #654 task-c — dirty-preflight porcelain lines (the caller parks with these). */
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
  // #750 — the restore is verified, not assumed (see work-driver-restore.ts).
  const restoreRoot = async (): Promise<VerifiedRestoreResult> =>
    originalRef
      ? verifiedRestoreRoot(execFn, {
          repoRoot,
          originalRef,
          scratchDir: opts.scratchDir,
          label: "integrate",
        })
      : { restored: true };
  // The verified post-condition via the shared claim builder, wrapped with
  // the ref the root was restored to (the helper's two shapes are kept
  // verbatim; the ref is load-bearing for the operator's retry).
  const claimFor = (r: VerifiedRestoreResult): string => {
    const claim = restoreClaim(r);
    return r.restored ? `repoRoot was restored to ${originalRef} (verified)` : claim;
  };
  try {
    // 1. Preflight: repoRoot must be clean of TRACKED dirt before we touch
    //    its checkout. `.worktrees/` scaffolding and untracked `??` entries
    //    are not dirt: they are never staged into the integration (git add
    //    is explicit per-path) and untracked content is deliberately
    //    preserved (the restore never runs `git clean`).
    const { stdout: rootStatus } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const rootDirt = rootStatus
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("??") && !/^..\s+"?\.worktrees\//.test(l));
    if (rootDirt.length > 0) {
      const files = rootDirt
        .slice(0, 10)
        .map((l) => l.slice(3))
        .join(", ");
      return {
        ok: false,
        failure: "dirty-repoRoot",
        reason: `repo root has uncommitted tracked changes, refusing to integrate onto ${branchName}: ${files}. Commit, stash, or discard them — integration would otherwise sweep them into the PR.`,
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
    // #750 — the claim states the VERIFIED post-condition only.
    if (orchResult._conflict === "conflict") {
      const restore = await restoreRoot();
      return {
        ok: false,
        failure: "apply",
        reason: `cherry-pick conflict — the batch was aborted. ${claimFor(restore)}.`,
      };
    }

    // Handle requireAllNonEmpty failure for a no-diff workstream.
    if (orchResult._noDiffRequireFail !== undefined) {
      const id = orchResult._noDiffRequireFail;
      const restore = await restoreRoot();
      return {
        ok: false,
        reason: `worktree '${id}' has no uncommitted work — nothing to consolidate. ${claimFor(restore)}.`,
        noDiff: Object.keys(orchResult.noDiff).length > 0 ? orchResult.noDiff : undefined,
      };
    }

    // Handle patch-apply failure.
    if (orchResult._applyConflict !== undefined) {
      const { id, reason: applyReason, patchFile } = orchResult._applyConflict;
      const emptySlice = orchResult.emptyWorkstreams.slice(
        orchResult.emptyWorkstreams.indexOf(id) + 1,
      );
      const skipped = emptySlice.length > 0 ? ` Not attempted: ${emptySlice.join(", ")}.` : "";
      const restore = await restoreRoot();
      return {
        ok: false,
        failure: "apply",
        reason:
          `git apply failed for workstream '${id}': ${applyReason}.` +
          `${skipped} ${claimFor(restore)}.`,
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
        // #749 — carry the dedup discriminator: "nothing produced" vs
        // "work exists and its content is already on the branch".
        const skipped = orchResult.skippedAlreadyOnBranch ?? [];
        return {
          ok: true,
          workstreams: [],
          empty: true,
          noDiff,
          ...(skipped.length > 0 ? { skippedAlreadyOnBranch: skipped } : {}),
        };
      }
    } else {
      // No baseSha — check if there are staged changes (patch fallback).
      if (appliedWorkstreams.length === 0) {
        const { stdout: hasStaged2 } = await execFn("git diff --cached --name-only", {
          cwd: repoRoot,
          maxBuffer: 64 * 1024,
        });
        if (!hasStaged2.trim()) {
          const skipped = orchResult.skippedAlreadyOnBranch ?? [];
          return {
            ok: true,
            workstreams: [],
            empty: true,
            noDiff,
            ...(skipped.length > 0 ? { skippedAlreadyOnBranch: skipped } : {}),
          };
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
        const restore = await restoreRoot();
        return {
          ok: false,
          failure: "verify",
          reason:
            `the consolidated tree fails the project's verify command (\`${opts.verifyCmd}\`), so it was not pushed. ` +
            `Each workstream passed alone; the combination does not. Tail: ${failure.slice(-600)} ` +
            `${claimFor(restore)}.`,
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
      completeness: orchResult.completeness,
    };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    // Anything that threw mid-integration leaves the same half-applied tree a
    // conflict does, so it gets the same treatment.
    const restore = await restoreRoot();
    return {
      ok: false,
      reason:
        `${(e.stderr ?? e.message ?? "unknown error").toString().trim().slice(0, 300)} ` +
        `${restore.restored ? "repoRoot was restored (verified)" : `repoRoot was NOT restored: ${restore.detail}`}`,
    };
  }
}
