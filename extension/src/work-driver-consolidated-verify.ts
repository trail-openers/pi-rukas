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
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";

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
  // #725 — the caller distinguishes a genuine cherry-pick / patch-apply
  // conflict from a dirty-repoRoot preflight refusal via `kind`, not by
  // regexing the `detail` prose (a reworded message used to silently
  // re-route the refusal to the conflict cap).
  | { status: "conflict"; detail: string; kind: "conflict" | "dirty-root" }
> {
  const { repoRoot, baseSha, worktrees, scratchDir, verifyCmd, timeoutMs } = opts;
  // A scratch branch name no other step of the cycle ever creates. Deleted
  // on the restore path below (a leftover branch costs nothing, but noise
  // is noise; the worktrees are untouched either way).
  const branchName = "pi-rukas-dev-verify";
  let originalRef: string | undefined;
  // #750 — the restore is verified, not assumed: preserves the discarded
  // state, resets, restores the checkout, and reports success only when the
  // porcelain read confirms the root is clean. The caller emits that
  // post-condition — it no longer asserts an unverified "restored".
  const restoreRoot = async (): Promise<VerifiedRestoreResult> => {
    if (!originalRef) return { restored: true };
    const result = await verifiedRestoreRoot(execFn, {
      repoRoot,
      originalRef,
      scratchDir,
      label: "consolidated verify",
    });
    // Delete the scratch branch so it does not accumulate on every develop
    // re-entry. Failure is non-fatal (a leftover branch costs nothing).
    await execFn(`git branch -D ${JSON.stringify(branchName)}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    }).catch(() => undefined);
    return result;
  };
  // The verified post-condition for the operator, via the shared claim
  // builder (the not-restored variant carries the preserved-diff location and
  // the still-dirty detail — the loud failure, never a bare "restored").
  const restoreClaimFor = (r: VerifiedRestoreResult) =>
    restoreClaim(r, "the batch was aborted and");
  try {
    // Preflight — same as integrate(): repoRoot must be clean before we
    // touch its checkout, or a dirty root would carry operator residue
    // onto the probe branch. Refuse to consolidate rather than guess.
    // `.worktrees/` and `.pi/` scaffolding are not dirt; untracked `??` IS
    // dirt (see the integrate() preflight comment for the reasoning).
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

    // Run the verify command against the combined tree.
    let verifyFailure: string | undefined;
    try {
      await execFn(verifyCmd, { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      verifyFailure = (e.stderr || e.stdout || e.message || "").toString().trim();
    }
    const restore = await restoreRoot();
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
      // #750 — the verified post-condition rides with every outcome of the
      // probe run (the root is transient either way; an unverified claim
      // about it is exactly the incident).
      return { status: "failed", detail: `${detail} ${restoreClaimFor(restore)}` };
    }
    if (!restore.restored) {
      trace(
        `work-driver: consolidated verify — root not restored after a passing run: ${restore.detail}`,
      );
    }
    return { status: "passed", applied };
  } catch (err) {
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
}
