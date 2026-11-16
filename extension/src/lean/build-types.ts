/**
 * lean/build-types — the seams `build.ts` injects and `build-normalise.ts`
 * calls through.
 *
 * An orchestrator's types must be importable by the modules it orchestrates
 * (`build-git`, `build-capture`, `build-normalise`) without importing it back.
 */

import type { DispatchResult, DispatchSpec } from "../types.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import type { BudgetOpts } from "./step-budget.ts";

/**
 * The dispatch seam: one child, one result. `spawnSpecialist` in production.
 *
 * `BudgetOpts` carries the three budget levers, which are spawn options — a
 * seam without them could only enforce a budget by refusing to dispatch.
 */
export type BuildDispatch = (
  spec: DispatchSpec,
  opts: { writeFence?: WriteFence; extraArgs?: readonly string[] } & BudgetOpts,
) => Promise<DispatchResult>;

/** The git executor, in the driver's argv-form shape. */
export type BuildExec = ExecFn;

/**
 * What normalisation did, for the outcome reason. Empty `files` means there was
 * nothing to commit; the other four list what the step did about the child's
 * overreach, each one a path the commit does NOT hold (or holds as a deletion).
 */
export interface NormaliseReport {
  /** The paths the commit contains; empty when there was nothing to commit. */
  files: string[];
  /** Frozen paths the child changed, which the reset restored. */
  restored: string[];
  /** Protected paths the child changed, which the reset reverted. */
  reverted: string[];
  /**
   * Paths the step did not keep, each with why: a link, a device or a directory
   * the child left, a path behind one, a capture the reader refused, or a path
   * whose kind changed under the reset so it cannot be written.
   */
  removed: Array<{ path: string; why: string }>;
  /** Paths with no regular file behind them, deleted by the child. */
  deleted: string[];
}
