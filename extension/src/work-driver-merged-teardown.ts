/**
 * work-driver-merged-teardown — what a merged cycle leaves behind, run once the
 * merge has landed and the checkout is restored.
 *
 * Split from `work-driver-merged.ts` along the seam that already existed: every
 * step here is post-merge bookkeeping that must never convert a landed cycle into
 * a handoff, so each call is caught and traced rather than awaited-to-throw.
 *
 * The cleanups are one function because they share that contract and one
 * moment: the cycle is done. Releasing the path claim without forgetting the park
 * records would have a later start refuse on a park whose work the operator can
 * see is merged; forgetting only one of the two park channels leaves the same
 * lie in the survivor. A cycle that did one and not the other is the bug this
 * grouping prevents. The cycle's `refs/pi-rukas/*` backups go here too, but
 * only once the merge is proven: they exist for a rerun of the issue, and a merged
 * issue has none, while an unproven merge may still be reworked.
 */

import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { clearHostParkSignals } from "./work-driver-park-memory-host.ts";
import { clearParkRecords } from "./work-driver-park-record.ts";
import { releaseClaim } from "./work-driver-path-claims.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";
import { type ExecFn, worktreePrune, worktreeRemove } from "./worktree.ts";

/**
 * Tear down this cycle's worktrees, release its path claims, and forget its park
 * records — the whole post-merge cleanup, all of it best-effort.
 *
 * `state` is the pre-merge state: claims and park records are keyed on the
 * cycle's active issues, and worktrees on the ids `pipelineState.worktrees`.
 * `mergeProven` is the driver's own merge evidence; an ops-fallback merge that
 * only a child reported keeps the backup refs.
 */
export async function runMergedTeardown(
  ctx: CycleContext,
  state: WorkState,
  next: WorkState,
  mergeProven: boolean,
): Promise<void> {
  // Worktrees accumulate unless the cycle that created them removes them.
  const wtToRemove = Object.keys(next.pipelineState.worktrees ?? {});
  if (wtToRemove.length > 0) {
    const execFnWt = ctx.verifyExecFn ?? execp;
    // `git worktree prune` touches the shared worktree admin area, so a
    // sibling's `worktree add` can collide with it. Same lock.
    await withIntegrationLock(ctx.repoRoot, async () => {
      for (const id of wtToRemove) {
        await worktreeRemove(execFnWt, ctx.repoRoot, `issue-${ctx.issue}-${id}`, true).catch(
          (err) =>
            trace(`work-driver: worktree cleanup for '${id}' failed: ${(err as Error).message}`),
        );
      }
      await worktreePrune(execFnWt, ctx.repoRoot).catch(() => undefined);
    });
  }

  const issues = activeIssuesOf(state);
  // The WHOLE group: a grouped cycle claims every issue, so releasing only the
  // primary would leave a sibling parked over a merged cycle.
  try {
    await releaseClaim(ctx.repoRoot, issues);
  } catch {
    /* best-effort; merge must always succeed regardless */
  }
  // The park records. A park against a merged issue describes a state of the
  // world that no longer exists, and refusing a LATER start on it would hold up
  // work the operator can see is done.
  try {
    await clearParkRecords(ctx.repoRoot, issues);
  } catch {
    /* best-effort; merge must always succeed regardless */
  }
  // And the host channel's signal, from the same door as the records above.
  try {
    await clearHostParkSignals(ctx.repoRoot, issues);
  } catch {
    /* best-effort; merge must always succeed regardless */
  }
  if (!mergeProven) return;
  await deleteIssueRefs(ctx.verifyExecFn ?? execp, ctx.repoRoot, issues).catch((err) =>
    trace(`work-driver: backup ref cleanup failed: ${(err as Error).message}`),
  );
}

/**
 * The issue a `refs/pi-rukas/<namespace>/<key>[/…]` ref belongs to, read from
 * `<key>`: `issue-<N>` (every issue-keyed namespace), `<N>-<workstream>-<n>`
 * (fix-pass-strays), and `issue-<N>-<title>`, the `branchSlug` stem older builds
 * keyed lens-fix backups on (always a single issue: the reposition is called
 * with the cycle's primary issue only). Any other key belongs to no issue.
 */
function refIssue(ref: string): number | undefined {
  const key = ref.split("/")[3] ?? "";
  const m = /^issue-(\d+)(?:-|$)/.exec(key) ?? /^(\d+)-/.exec(key);
  return m ? Number(m[1]) : undefined;
}

/** Delete every `refs/pi-rukas/*` ref that belongs to one of `issues`. */
async function deleteIssueRefs(execFn: ExecFn, repoRoot: string, issues: number[]): Promise<void> {
  const { stdout } = await execFn("git", {
    cwd: repoRoot,
    maxBuffer: 4 * 1024 * 1024,
    argv: ["for-each-ref", "--format=%(refname)", "refs/pi-rukas/"],
  });
  for (const ref of stdout.split("\n").map((l) => l.trim())) {
    const issue = ref ? refIssue(ref) : undefined;
    if (issue === undefined || !issues.includes(issue)) continue;
    await execFn("git", { cwd: repoRoot, argv: ["update-ref", "-d", ref] }).catch((err) =>
      trace(`work-driver: could not delete ${ref}: ${(err as Error).message}`),
    );
  }
}
