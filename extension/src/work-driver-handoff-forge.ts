/** work-driver-handoff-forge — the forge the Step 7g handoff posts through.
 *
 * Resolved through `resolveCycleForge`, the same guarded detection the cycle's
 * own steps use, so the handoff and the commit step can never disagree about
 * which forge a repo is on (a handoff posting via `glab` while commit-pr
 * refused `gh` is the divergence that rule exists to prevent).
 */
import type { Forge } from "./forge.ts";
import { resolveCycleForge } from "./work-driver-forge-ctx.ts";

export function handoffForge(repoRoot: string): Promise<Forge | undefined> {
  return resolveCycleForge(repoRoot, { traceLabel: "handoff" });
}
