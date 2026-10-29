/**
 * lean/challenge-types — the seams `challenge.ts` injects.
 *
 * Split out for the same reason `build-types.ts` is: the orchestrator's seams
 * must be importable by the modules it orchestrates (`challenge-dispatch.ts`)
 * without importing the step back.
 */

import type { DispatchResult, DispatchSpec } from "../types.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";

/** The dispatch seam: one adversary, one result. `spawnSpecialist` in production. */
export type ChallengeDispatch = (
  spec: DispatchSpec,
  opts: { writeFence?: WriteFence; extraArgs?: readonly string[] },
) => Promise<DispatchResult>;

/** The git executor, in the driver's argv-form shape. */
export type ChallengeExec = ExecFn;
