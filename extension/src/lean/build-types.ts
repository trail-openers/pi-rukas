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
 * `BudgetOpts` carries the budget levers, which are spawn options — a seam
 * without them could only enforce a budget by refusing to dispatch.
 */
export type BuildDispatchOpts = {
  writeFence?: WriteFence;
  extraArgs?: readonly string[];
} & BudgetOpts;

export type BuildDispatch = (
  spec: DispatchSpec,
  opts: BuildDispatchOpts,
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
  /** The clause naming a submodule the reset's pass could not populate, or `undefined` when
   *  every one came from disk. Carried on the report rather than traced: the step that owns the
   *  reason line has to be able to say it, since a commit built on a tree with no submodule in
   *  it is one no later run can reproduce. */
  submodules?: string;
  /** The configured protected globs (`lean.protectedPaths`) that named no path of their own in
   *  this fold's changed set, in the order the project wrote them, or `undefined` with no
   *  configured list. An inert rule is the one way a protection rots silently, so the fold says
   *  which were inert; it is never a refusal. Built-in paths are deliberately absent: the
   *  built-in list is the shipped rule rather than one the project wrote. Carried as the paths
   *  themselves, not a pre-joined clause: the reason line owns the wording, and the budget
   *  accumulator merges these across folds. */
  protectedUnmatched?: string[];
}
