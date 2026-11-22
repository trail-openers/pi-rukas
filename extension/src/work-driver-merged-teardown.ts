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
 *
 * The worktree half removes every tree the cycle owns, not every tree a state
 * key names. `pipelineState.worktrees` holds the owner's tree under the OWNER's
 * key after a fence merge re-points that key at the violator's tree, and the
 * integrate tree is recorded outside the map entirely, so deriving removal names
 * from the keys alone leaves both on disk after a proven merge. The candidate set
 * is therefore map VALUES plus derived key paths plus `integrateWorktree`, and
 * each candidate passes the launch sweep's own two gates (`claimUnderWorktrees`,
 * then `resolveSweepTarget`) before it can reach git — the same gate the sweep
 * applies, so a hostile state key never reaches `git worktree remove`.
 */

import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { clearHostParkSignals } from "./work-driver-park-memory-host.ts";
import { clearParkRecords } from "./work-driver-park-record.ts";
import { releaseClaim } from "./work-driver-path-claims.ts";
import { executeSweepAction } from "./work-driver-sweep-policy.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import { claimUnderWorktrees } from "./work-driver-worktree-sweep-owners.ts";
import { type SweepTargetResult, resolveSweepTarget } from "./work-driver-worktree-sweep.ts";
import type { WorkState } from "./workflow-state.ts";
import { type ExecFn, worktreePath, worktreePrune } from "./worktree.ts";

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
  await removeCycleWorktrees(ctx, next);

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
 * Remove every worktree the merged cycle owns, then prune its admin records.
 *
 * Three sources, gathered from the POST-merge state (`next`) because the merge
 * just released these trees and `state` is keyed on the group's active issues
 * — right for claims and park records, wrong for the trees:
 *
 *  - the `pipelineState.worktrees` VALUES (the tree each key currently names —
 *    after a fence merge that is the violator's tree);
 *  - the derived `issue-<N>-<key>` path of every KEY (the owner's own tree, which
 *    the fence merge orphans by re-pointing its key at another tree), built by
 *    `worktreePath` — the same builder `integrateWorktreePath` uses, so neither
 *    derived shape spells `.worktrees` itself;
 *  - `pipelineState.integrateWorktree`, which lives outside the map. It goes
 *    regardless of `lastCapShape`: that gate exists in `runStopTeardown` because
 *    a handoff resumes FROM an integration-worktree violation, and a cycle that
 *    reached `merged` has proven its merge, so no such resume case exists.
 *
 * Shape tolerance: `worktrees` is typed `Record<string, string>` but the state
 * file is operator-editable JSON, so non-string values and empty keys are
 * filtered before use — same tolerance the sweep's owner index applies.
 *
 * Every candidate goes through the two gates in order — `claimUnderWorktrees`
 * (containment under `.worktrees/`) then `resolveSweepTarget` (real directory,
 * real worktree of THIS repo) — and removal is `executeSweepAction`'s
 * `remove`, never `worktreeRemove`: the latter takes a NAME and rebuilds the
 * path with `path.join`, which does not collapse `..`, so a traversal-shaped key
 * would reach git verbatim. A candidate either gate refuses is traced and
 * skipped: a since-removed integrate tree, a plain directory, the repo-root
 * fallback shape and a `../..` key are all refusals, never failures.
 *
 * The empty-candidate-set case returns before taking the lock, so a cycle that
 * owns no tree issues no git command at all.
 */
async function removeCycleWorktrees(ctx: CycleContext, next: WorkState): Promise<void> {
  const ps = next.pipelineState;
  const recorded: string[] = [];
  const worktrees: unknown = ps.worktrees;
  if (worktrees !== null && typeof worktrees === "object" && !Array.isArray(worktrees)) {
    for (const [id, value] of Object.entries(worktrees as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) recorded.push(value);
      if (id.length > 0) recorded.push(worktreePath(ctx.repoRoot, `issue-${ctx.issue}-${id}`));
    }
  }
  if (typeof ps.integrateWorktree === "string" && ps.integrateWorktree.length > 0) {
    recorded.push(ps.integrateWorktree);
  }
  const targets = new Map<string, SweepTargetResult>();
  for (const p of recorded) {
    const claimed = claimUnderWorktrees(ctx.repoRoot, p);
    const target = claimed === null ? undefined : resolveSweepTarget(ctx.repoRoot, claimed);
    if (!target?.ok) {
      trace(
        `work-driver: merged teardown skipped ${p}: ${target ? target.reason : "outside-worktrees"}`,
      );
      continue;
    }
    if (!targets.has(target.realPath)) targets.set(target.realPath, target);
  }
  if (targets.size === 0) return;
  const execFn: ExecFn = ctx.verifyExecFn ?? execp;
  // `git worktree remove`/`prune` touch the shared admin area a sibling's
  // `worktree add` also writes.
  await withIntegrationLock(ctx.repoRoot, async () => {
    for (const target of targets.values()) {
      await executeSweepAction({ type: "remove", target }, execFn).catch((err) =>
        trace(`work-driver: worktree cleanup for ${target.realPath} failed: ${err}`),
      );
    }
    await worktreePrune(execFn, ctx.repoRoot).catch(() => undefined);
  });
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
