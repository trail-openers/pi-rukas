// #669 — consolidated develop-time verify: all workstreams' commits
// cherry-picked onto the integration branch at repoRoot, then ONE verify
// run against the combined tree. The develop-time twin of the commit-pr
// verify in `integrate()`: same `orchestrateCherryPick` machinery, same
// restore-on-failure contract. Differences: NO push, NO worktree advance
// (#453 invariant — worktrees are only advanced after a successful push,
// which commit-pr owns); `requireAllNonEmpty: false` (a workstream with no
// commit simply contributes nothing); repoRoot is ALWAYS restored
// afterwards (the combined tree is a transient probe; leaving it on a
// scratch ref would break the next integration's dirty-preflight).
//
// #782 — single bounded flake retry. When the consolidated run fails and
// the caller asks for a retry (N>1, every per-worktree verify passed), the
// SAME verify command is re-run ONCE on the same still-checked-out scratch
// tree, BEFORE the restore. A test that fails twice is not a flake — the
// second failure is returned to the caller for classification as today.

import { trace } from "./trace.ts";
import { orchestrateCherryPick } from "./work-driver-cherry-pick.js";
import type { DriverContext } from "./work-driver-context.js";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";

export type ConsolidatedVerifyResult =
  | {
      status: "passed";
      applied: string[];
      /** #782 — 1 when the first run failed and the re-run passed. */
      retries?: 1;
      recovered?: true;
    }
  | {
      status: "failed";
      detail: string;
      /** Raw combined stdout+stderr of the FIRST failing run. */
      firstRunOutput: string;
      /** #782 — set when the caller requested a retry and one was performed. */
      retried?: true;
      /** #782 — true when the re-run passed. Absent when no retry was requested. */
      recovered?: boolean;
      /** #782 — set when `deferRestore` is true and the caller must invoke
       *  `restoreConsolidatedVerifyRoot` to undo the scratch checkout. */
      deferredOriginalRef?: string;
    }
  | { status: "conflict"; detail: string; kind: "conflict" | "dirty-root" };

/** The scratch branch name — no other step of the cycle ever creates it. */
export const CONSOLIDATED_VERIFY_BRANCH = "pi-rukas-dev-verify";

/**
 * #782 — the single bounded flake retry for the CONSOLIDATED-tree verify.
 *
 * Precondition (enforced by the caller, `verifyDevelopOutcome`):
 *   1. The first consolidated run failed.
 *   2. workstreamCount > 1 (N=1 is a no-op consolidation).
 *   3. Every per-worktree verify passed.
 *
 * Exactly one re-run — never a loop. The caller MUST invoke this BEFORE
 * restoring the scratch tree; a re-run after restore would test the wrong
 * tree (the restored mainline). If the scratch branch is no longer checked
 * out (the caller restored early), the retry is skipped and `recovered` is
 * false — the caller then classifies and parks as today.
 */
export async function retryConsolidatedVerify(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  opts: {
    repoRoot: string;
    verifyCmd: string;
    timeoutMs: number;
    firstRunOutput: string;
  },
): Promise<{ recovered: boolean; retries: 1 }> {
  let currentRef = "";
  try {
    currentRef = (
      await execFn("git symbolic-ref --quiet --short HEAD", {
        cwd: opts.repoRoot,
        maxBuffer: 64 * 1024,
      })
    ).stdout.trim();
  } catch {
    // detached HEAD or read failure — treat as "not on scratch branch".
  }
  if (currentRef !== CONSOLIDATED_VERIFY_BRANCH) {
    trace(
      `work-driver: consolidated verify flake retry skipped — repoRoot is on '${currentRef || "(detached)"}', not '${CONSOLIDATED_VERIFY_BRANCH}'`,
    );
    return { recovered: false, retries: 1 };
  }
  trace(
    `work-driver: consolidated verify flake retry — re-running the SAME command in the SAME scratch tree (first-run failure: ${opts.firstRunOutput.slice(0, 120)})`,
  );
  try {
    await execFn(opts.verifyCmd, {
      cwd: opts.repoRoot,
      timeout: opts.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { recovered: true, retries: 1 };
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    trace(
      `work-driver: consolidated verify flake retry FAILED (re-run also failed): ${((e.stderr || e.stdout || e.message) as string).slice(0, 120)}`,
    );
    return { recovered: false, retries: 1 };
  }
}

/**
 * #782 — restore repoRoot after a deferred-restore consolidated verify.
 * The caller invokes this AFTER `retryConsolidatedVerify` (or after deciding
 * not to retry), so the scratch branch does not survive into the next step.
 */
export async function restoreConsolidatedVerifyRoot(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  opts: { repoRoot: string; originalRef: string; scratchDir: string },
): Promise<VerifiedRestoreResult> {
  const result = await verifiedRestoreRoot(execFn, {
    repoRoot: opts.repoRoot,
    originalRef: opts.originalRef,
    scratchDir: opts.scratchDir,
    label: "consolidated verify (deferred)",
  });
  await execFn(`git branch -D ${JSON.stringify(CONSOLIDATED_VERIFY_BRANCH)}`, {
    cwd: opts.repoRoot,
    maxBuffer: 64 * 1024,
  }).catch(() => undefined);
  return result;
}

export async function runConsolidatedVerify(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  opts: {
    repoRoot: string;
    baseSha: string;
    worktrees: Record<string, string>;
    scratchDir: string;
    verifyCmd: string;
    timeoutMs: number;
    /**
     * #782 — when true, the restore is DEFERRED (the scratch branch stays
     * checked out) so the caller can invoke `retryConsolidatedVerify` on the
     * same still-checked-out tree. The caller MUST restore via
     * `restoreConsolidatedVerifyRoot` before any further git operations.
     * Default false — the legacy restore-immediately contract.
     */
    deferRestore?: boolean;
  },
): Promise<ConsolidatedVerifyResult> {
  const { repoRoot, baseSha, worktrees, scratchDir, verifyCmd, timeoutMs } = opts;
  const branchName = CONSOLIDATED_VERIFY_BRANCH;
  let originalRef: string | undefined;
  let deferred = false;
  const restoreRoot = async (): Promise<VerifiedRestoreResult> => {
    if (!originalRef || deferred) return { restored: true };
    const result = await verifiedRestoreRoot(execFn, {
      repoRoot,
      originalRef,
      scratchDir,
      label: "consolidated verify",
    });
    await execFn(`git branch -D ${JSON.stringify(branchName)}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    }).catch(() => undefined);
    return result;
  };
  const restoreClaimFor = (r: VerifiedRestoreResult) =>
    restoreClaim(r, "the batch was aborted and");
  try {
    // Preflight — same as integrate(): repoRoot must be clean before we
    // touch its checkout. `.worktrees/` and `.pi/` scaffolding are not dirt;
    // untracked `??` IS dirt.
    const { stdout: rootStatus } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const rootDirt = rootStatus
      .split("\n")
      .filter((l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l) && !/^..\s+"?\.pi\//.test(l));
    if (rootDirt.length > 0) {
      trace("work-driver: consolidated verify — repoRoot dirty, refusing to consolidate");
      return {
        status: "conflict",
        kind: "dirty-root",
        detail: `repoRoot is dirty (${rootDirt
          .slice(0, 5)
          .map((l) => l.slice(3))
          .join(
            ", ",
          )}); consolidated verify skipped — the combination is unverifiable until the root is clean`,
      };
    }

    originalRef = await execFn("git symbolic-ref --quiet --short HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    })
      .then((r) => r.stdout.trim())
      .catch(async () =>
        (await execFn("git rev-parse HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 })).stdout.trim(),
      );

    await execFn(`git checkout -B ${JSON.stringify(branchName)} ${JSON.stringify(baseSha)}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });

    const orchResult = await orchestrateCherryPick(execFn, {
      repoRoot,
      branchName,
      worktrees: { ids: Object.keys(worktrees), worktrees, commitShas: {} },
      baseSha,
      scratchDir,
      requireAllNonEmpty: false,
    });

    if (orchResult._conflict === "conflict") {
      const restore = await restoreRoot();
      return {
        status: "conflict",
        kind: "conflict",
        detail: `cherry-pick conflict — two workstreams edited the same lines; ${restoreClaimFor(restore)}`,
      };
    }
    if (orchResult._applyConflict !== undefined) {
      const { id, reason, patchFile } = orchResult._applyConflict;
      const restore = await restoreRoot();
      return {
        status: "conflict",
        kind: "conflict",
        detail: `patch-apply failed for workstream '${id}': ${reason}. Conflict patch preserved at ${patchFile}. ${restoreClaimFor(restore)}`,
      };
    }

    const applied =
      orchResult.cherryApplied.length > 0 ? orchResult.cherryApplied : orchResult.patchApplied;

    // Run the verify command against the combined tree.
    let verifyOutput = "";
    let verifyFailed = false;
    try {
      await execFn(verifyCmd, { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      verifyOutput = (e.stderr || e.stdout || e.message || "").toString().trim();
      verifyFailed = true;
    }

    if (verifyFailed && opts.deferRestore) {
      // #782 — the caller wants to retry: keep the scratch tree checked out.
      // The caller is responsible for the retry and the restore before any
      // further git work at repoRoot.
      deferred = true;
      trace(
        "work-driver: consolidated verify — first run failed; deferring restore for the flake retry",
      );
      return {
        status: "failed",
        detail: "",
        firstRunOutput: verifyOutput,
        deferredOriginalRef: originalRef,
      };
    }

    const restore = await restoreRoot();
    if (!verifyFailed) {
      if (!restore.restored) {
        trace(
          `work-driver: consolidated verify — root not restored after a passing run: ${restore.detail}`,
        );
      }
      return { status: "passed", applied };
    }
    // #723 — same attribution anchor as formatExecError: a bare `.slice(-800)`
    // can splice a passing sub-command's tail onto a later failure.
    const { tail, attributed } = extractAttributedTail(verifyOutput, 800);
    if (!attributed && tail) {
      trace("work-driver: consolidated verify tail is unattributed (no FAILED: marker found)");
    }
    const detail = tail
      ? attributed
        ? tail
        : `${tail} (unattributed — best-effort tail)`
      : "verify command exited non-zero";
    return {
      status: "failed",
      detail: `${detail} ${restoreClaimFor(restore)}`,
      firstRunOutput: verifyOutput,
    };
  } catch (err) {
    if (!deferred) {
      const restore = await restoreRoot();
      trace(
        `work-driver: consolidated verify — unexpected error: ${(err as Error).message?.slice(0, 200)}`,
      );
      return {
        status: "conflict",
        kind: "conflict",
        detail: `consolidation could not be performed: ${(err as Error).message?.slice(0, 200)}. ${restoreClaimFor(restore)}`,
      };
    }
    trace(
      `work-driver: consolidated verify — unexpected error during deferred restore: ${(err as Error).message?.slice(0, 200)}`,
    );
    return {
      status: "failed",
      detail: `unexpected error: ${(err as Error).message?.slice(0, 200)}`,
      firstRunOutput: "",
    };
  }
}
