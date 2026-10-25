/**
 * work-driver-handoff-consolidate-restore — the restore every failure path of
 * the handoff consolidation shares (#1788 round 6 split).
 *
 * Every degradation in `consolidateWorktreesToBranch` — a cherry-pick conflict,
 * a patch that would not apply, a git error, a commit message the public
 * hygiene guard refused — has to put repoRoot back on the ref it was on before
 * consolidation switched its checkout, and say whether it managed. That is the
 * same call in four places, so it lives here: a failure path that forgot the
 * restore is the failure that leaves the operator's checkout on a half-built
 * branch with no claim saying so.
 *
 * `restoreRootToRefPreserving` never throws, so a caller can always produce a
 * reason. `originalRef` is undefined when nothing was ever checked out (the
 * cycle-start ref was never recorded and no mainline resolved); then there is
 * nothing to restore, and the caller says so instead of running a command — the
 * same answer the two-step pre-#1788 code produced with its ternary.
 */

import { restoreClaim, restoreRootToRefPreserving } from "./work-driver-restore.ts";
import type { ExecFn } from "./worktree.ts";

/** The context a consolidation restore needs, all of it threaded from the cycle. */
export interface ConsolidateRestoreCtx {
  repoRoot: string;
  scratchDir: string;
  dirtyRootExempt?: readonly string[];
  dirtyRootExemptBaseline?: readonly string[];
}

/** The restore + the operator-facing claim, or the honest "nothing to restore". */
export async function restoreConsolidationRoot(
  execFn: ExecFn,
  ctx: ConsolidateRestoreCtx,
  originalRef: string | undefined,
  /** Where the work is when the restore cannot be made — the recovery hint. */
  trailing = "run git status at the repo root",
): Promise<{ restoreClaim: string; restored: boolean }> {
  if (originalRef === undefined) {
    return {
      restoreClaim: `repoRoot was not touched (no restore target was recorded) — ${trailing}`,
      restored: false,
    };
  }
  const restore = await restoreRootToRefPreserving(execFn, {
    repoRoot: ctx.repoRoot,
    ref: originalRef,
    scratchDir: ctx.scratchDir,
    label: "handoff consolidation",
    dirtyRootExempt: ctx.dirtyRootExempt,
    dirtyRootExemptBaseline: ctx.dirtyRootExemptBaseline,
  });
  return { restoreClaim: restoreClaim(restore, { trailing }), restored: restore.restored };
}

/**
 * One consolidation restore call with the cycle context read straight off the
 * caller's `ctx` — the three failure paths and the publish-refusal path all
 * pass the same four fields, and spelling them out at each site is what pushed
 * the owning module past the size cap. `ctx` is the shape
 * `consolidateWorktreesToBranch` already takes.
 */
export async function restoreConsolidationFor(
  execFn: ExecFn,
  ctx: ConsolidateRestoreCtx,
  originalRef: string | undefined,
): Promise<{ restoreClaim: string; restored: boolean }> {
  return restoreConsolidationRoot(execFn, ctx, originalRef);
}
