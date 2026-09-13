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

import { trace } from "./trace.ts";
import { orchestrateCherryPick } from "./work-driver-cherry-pick.js";
import type { DriverContext } from "./work-driver-context.js";
import { extractAttributedTail } from "./work-driver-exec-error.ts";

export async function runConsolidatedVerify(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  opts: {
    repoRoot: string;
    baseSha: string;
    branchName?: string;
    worktrees: Record<string, string>;
    scratchDir: string;
    verifyCmd: string;
    timeoutMs: number;
  },
): Promise<
  | { status: "passed"; applied: string[] }
  | { status: "failed"; detail: string }
  | { status: "conflict"; detail: string }
> {
  const { repoRoot, baseSha, worktrees, scratchDir, verifyCmd, timeoutMs } = opts;
  // A scratch branch name no other step of the cycle ever creates. Deleted
  // on the restore path below (a leftover branch costs nothing, but noise
  // is noise; the worktrees are untouched either way).
  const branchName = "pi-rukas-dev-verify";
  let originalRef: string | undefined;
  const restoreRoot = async () => {
    if (!originalRef) return;
    await execFn("git reset --hard", { cwd: repoRoot, maxBuffer: 256 * 1024 }).catch((err) =>
      trace(
        `work-driver: consolidated verify — reset --hard failed: ${(err as Error).message?.slice(0, 160)}`,
      ),
    );
    await execFn(`git checkout --force ${JSON.stringify(originalRef)}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    }).catch((err) =>
      trace(
        `work-driver: consolidated verify — could not restore repoRoot to ${originalRef}: ${(err as Error).message?.slice(0, 160)}`,
      ),
    );
    // Delete the scratch branch so it does not accumulate on every develop
    // re-entry. Failure is non-fatal (a leftover branch costs nothing).
    await execFn(`git branch -D ${JSON.stringify(branchName)}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    }).catch(() => undefined);
  };
  try {
    // Preflight — same as integrate(): repoRoot must be clean before we
    // touch its checkout, or a dirty root would carry operator residue
    // onto the probe branch. Refuse to consolidate rather than guess.
    const { stdout: rootStatus } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const rootDirt = rootStatus
      .split("\n")
      .filter(
        (l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l) && !/^..\s+"?(\.pi|tmp)\//.test(l),
      );
    if (rootDirt.length > 0) {
      trace("work-driver: consolidated verify — repoRoot dirty, refusing to consolidate");
      return {
        status: "conflict",
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
      await restoreRoot();
      return {
        status: "conflict",
        detail:
          "cherry-pick conflict — two workstreams edited the same lines; the batch was aborted and repoRoot restored",
      };
    }
    if (orchResult._applyConflict !== undefined) {
      const { id, reason, patchFile } = orchResult._applyConflict;
      await restoreRoot();
      return {
        status: "conflict",
        detail: `patch-apply failed for workstream '${id}': ${reason}. Conflict patch preserved at ${patchFile}`,
      };
    }

    // Run the verify command against the combined tree.
    let verifyFailure: string | undefined;
    try {
      await execFn(verifyCmd, { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      verifyFailure = (e.stderr || e.stdout || e.message || "").toString().trim();
    }
    await restoreRoot();
    const applied =
      orchResult.cherryApplied.length > 0 ? orchResult.cherryApplied : orchResult.patchApplied;
    if (verifyFailure !== undefined) {
      // #723 — same attribution anchor as formatExecError: a bare `.slice(-800)`
      // can splice a passing sub-command's tail onto a later failure.
      const { tail, attributed } = extractAttributedTail(verifyFailure, 800);
      if (!attributed && tail) {
        trace("work-driver: consolidated verify tail is unattributed (no FAILED: marker found)");
      }
      const detail = tail
        ? attributed
          ? tail
          : `${tail} (unattributed — best-effort tail)`
        : "verify command exited non-zero";
      return { status: "failed", detail };
    }
    return { status: "passed", applied };
  } catch (err) {
    await restoreRoot();
    trace(
      `work-driver: consolidated verify — unexpected error: ${(err as Error).message?.slice(0, 200)}`,
    );
    return {
      status: "conflict",
      detail: `consolidation could not be performed: ${(err as Error).message?.slice(0, 200)}`,
    };
  }
}
