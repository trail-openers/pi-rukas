/**
 * lean/build-types — the seams `build.ts` injects and `build-normalise.ts`
 * calls through.
 *
 * Split out because the normalisation now spans three modules (`build-git`,
 * `build-capture`, `build-normalise`) and an orchestrator's types must be
 * importable by the things it orchestrates without importing it back.
 */

import type { DispatchResult, DispatchSpec } from "../types.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";

/** The dispatch seam: one child, one result. `spawnSpecialist` in production. */
export type BuildDispatch = (
  spec: DispatchSpec,
  opts: { writeFence?: WriteFence; extraArgs?: readonly string[] },
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
