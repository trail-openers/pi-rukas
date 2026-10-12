/**
 * work-driver-adversarial-lens-integrate — re-integrates a lens-fix made in a
 * worktree onto the branch (#287 Part C, #654 task-c). Split out of
 * work-driver-adversarial.ts (the 500-line cap); behaviour is unchanged.
 */

import type { DriverContext } from "./work-driver-context.ts";
import { integrate, restoreRepoRoot } from "./work-driver-integrate.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import type { ExecFn } from "./worktree.ts";

/** #287 Part C — re-integrate a lens-fix made in a worktree (#654 task-c). */
export async function integrateLensFix(
  execFn: ExecFn,
  ctx: DriverContext,
  ps: PipelineState,
  worktrees: Record<string, string>,
): Promise<{ committed: boolean; error?: string; pushed?: boolean }> {
  const branchName = ps.branchName;
  if (!branchName) return { committed: false, error: "no branch name recorded" };
  const round = ps.reviewRound;
  const res = await withIntegrationLock(ctx.repoRoot, () =>
    integrate(execFn, {
      repoRoot: ctx.repoRoot,
      branchName,
      worktrees,
      // #794 — own-range selection (stacked workstreams: see workstreamBaseShas).
      workstreamBaseShas: ps.workstreamBaseShas,
      scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
      commitTitle: `fix(lens): round ${round} review findings`,
      commitBody: `Addresses six-pass review findings from round ${round}.`,
      mode: "followup",
    }),
  );
  if (!res.ok) {
    if (res.failure === "dirty-repoRoot" && res.porcelain) {
      const outcome = await restoreRepoRoot(execFn, ctx.repoRoot, res.porcelain);
      if (outcome.restored) {
        const retry = await integrate(execFn, {
          repoRoot: ctx.repoRoot,
          branchName,
          worktrees,
          // #794 — same pick scope as the first pass above.
          workstreamBaseShas: ps.workstreamBaseShas,
          scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
          commitTitle: `fix(lens): round ${round} review findings`,
          commitBody: `Addresses six-pass review findings from round ${round}.`,
          mode: "followup",
        });
        if (!retry.ok) {
          return {
            committed: false,
            error: `restored repoRoot (stash+pop) but the retry still failed: ${retry.reason}`,
          };
        }
        if (retry.empty) return { committed: false };
        return { committed: true, pushed: true };
      }
      return {
        committed: false,
        error: `dirty repoRoot at lens-fix time, not safely restorable — ${outcome.reason}. Porcelain: ${res.porcelain
          .slice(0, 5)
          .join("; ")}`,
      };
    }
    return { committed: false, error: res.reason };
  }
  if (res.empty) return { committed: false };
  return { committed: true, pushed: true };
}
