/**
 * lean/verify-types — the two seams the verify step reaches the outside world
 * through, and the error it throws when the machine, not the code, is wrong.
 *
 * Its own module for the same reason `build-errors.ts` exists: `verify-steps.ts`
 * runs the tiers and `verify-frozen.ts` runs the frozen files, and both must be
 * able to refuse without importing the orchestrator that owns them. An import
 * cycle between the three would be the only reason they could not be read alone.
 */

import type { VerifyExecFn } from "../work-driver-git.ts";
import type { ExecFn } from "../worktree.ts";

/**
 * The executor this step's git probes need. `ExecFn` (the shape the ownership
 * and blob probes take) carries `stdoutEncoding`, which `VerifyExecFn` does not
 * declare, and `VerifyExecFn` carries `killGroup`, which `ExecFn` does not.
 * The production executor (`execp`) satisfies both, so the step's seam is the
 * intersection — asking for either one alone would drop the other.
 */
export type VerifyExec = ExecFn & VerifyExecFn;

/** The project's verify commands and the per-file runner template, as configured. */
export interface VerifyTiers {
  fast?: string;
  full?: string;
  test?: string;
}

/** A tree, a tier or a runner this step cannot trust. The engine makes it exit 10. */
export class VerifyInfraError extends Error {
  override readonly name = "VerifyInfraError";
}
