/**
 * work-driver-forge-type — the ONE place the driver asks "which forge is this
 * cycle on?", for the consumers that need the TYPE rather than an adapter.
 *
 * `forgeForCycle` builds a full `Forge`; the merge-evidence gate needs only the
 * forge type, and asking it to resolve an adapter would put a `createForge` and
 * its exec wiring in front of a read that has no use for one. So this resolves
 * the type through the same `detectForge` seam, with the same test-seam
 * precedence every other driver read uses: an injected `ctx.forge` wins, because
 * a cycle whose harness injected an adapter must be judged on THAT forge.
 */

import type { DetectForgeOpts, ForgeType } from "./forge-detect.ts";
import { detectForge } from "./forge-detect.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/**
 * The forge this cycle's repo lives on, or `undefined` when it cannot be told.
 * `undefined` is passed through to callers unchanged rather than guessed: the
 * merge-evidence gate treats an unnamed forge as a tooling refusal, which is the
 * fail-closed answer this question deserves.
 */
export async function forgeTypeForCycle(
  ctx: Pick<DriverContext, "repoRoot" | "forge">,
  execFn: VerifyExecFn,
): Promise<ForgeType | undefined> {
  if (ctx.forge) return ctx.forge.forge;
  try {
    // The seam is structurally the same shell executor `forgeForCycle` casts for
    // the same reason (`VerifyExecFn` accepts the options `detectForge` passes).
    const det = await detectForge(ctx.repoRoot, {
      allowProbe: false,
      execFn: execFn as unknown as DetectForgeOpts["execFn"],
    });
    return det.forge === "unknown" ? undefined : det.forge;
  } catch {
    return undefined;
  }
}
