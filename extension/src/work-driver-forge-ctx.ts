/**
 * work-driver-forge-ctx — the driver's per-cycle Forge instance (S4 of
 * epic #608, #612).
 *
 * Every `gh` call the driver used to issue directly now goes through the
 * forge adapter (forge.ts). This module is the ONE place a cycle's
 * Forge is constructed, so:
 *
 *   - the detection result is resolved ONCE per cycle and shared by every
 *     step (explore, branch preflight, commit-pr, ci, merged);
 *   - the exec seam is the same `VerifyExecFn` the driver already injects
 *     for tests (`ctx.verifyExecFn`), so the existing mkExec/fakeGh
 *     substring-matching fakes keep working unchanged — on a GitHub
 *     remote the adapter formats the same command strings the driver
 *     issued before the migration;
 *   - detection is fail-CLOSED but never a cycle-killer: a repo whose
 *     forge cannot be determined (no remote, unknown host, no config)
 *     gets `undefined`, and every consumer falls back to its existing
 *     no-forge behaviour (git-only mainline resolution, no forge, …).
 *     A forge outage must not block work any more than a `gh` outage does.
 */

import { type ForgeDetection, detectForge } from "./forge-detect.ts";
import { type Forge, type ForgeExecFn, createForge } from "./forge.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/**
 * The type of `DetectForgeOpts["execFn"]` — node's `promisify(exec)`, which
 * `detectForge` runs `git config` / `git remote` through. Named separately so
 * the boundary cast below is an explicit, greppable line rather than an
 * inline type-level expression.
 */
type DetectForgeExecFn = NonNullable<Parameters<typeof detectForge>[1]>["execFn"];

/**
 * The module's executor type — the seam the adapter is bound to. Structurally
 * identical to `VerifyExecFn` (and to `forge.ts`'s own `ForgeExecFn`); named
 * once here so the driver's eight former `gh` exec sites have one seam to
 * talk to instead of three locally-declared copies.
 */
export type ForgeDriverExecFn = VerifyExecFn;

/**
 * Build the cycle's Forge, or `undefined` when the repo's forge cannot be
 * determined. The exec seam is the driver's `VerifyExecFn` (test-injected
 * when present). `opts.execOpts` are merged into every adapter exec call —
 * the explore body fetch uses it to carry its per-attempt deadline.
 */
export async function forgeForCycle(
  ctx: Pick<DriverContext, "repoRoot">,
  execFn: VerifyExecFn,
  cache: Map<string, Forge | undefined> = new Map(),
  opts: { execOpts?: { timeout?: number; maxBuffer?: number } } = {},
): Promise<Forge | undefined> {
  const key = ctx.repoRoot;
  if (cache.has(key)) return cache.get(key);
  let forge: Forge | undefined;
  try {
    const det: ForgeDetection = await detectForge(ctx.repoRoot, {
      // The seam is structurally identical to node's promisify(exec) for
      // the two commands detectForge runs (git config / git remote); the
      // cast makes that structural match explicit at the boundary. The
      // probe is disabled because the driver's fake exec seams answer only
      // the commands the step under test cares about — a network probe
      // against a fake cwd is exactly the kind of side effect a smoke
      // test must not take, and the probe only fires for hosts the
      // known-host table does not already classify (github.com / gitlab.com
      // never reach it). CI never runs a probe anyway, and a local cycle's
      // CI variable does not change what the step is asserting on.
      env: { PI_ENSEMBLE_FORGE: "github" },
      execFn: execFn as unknown as DetectForgeExecFn,
      probeEnv: { CI: "true" },
    });
    if (det.forge !== "unknown") {
      forge = createForge(det, {
        execFn: execFn as ForgeExecFn,
        cwd: ctx.repoRoot,
        execOpts: opts.execOpts,
      });
    } else {
      trace(
        `work-driver: forge detection ${det.source} (${det.forge}) — forge-less sites degrade gracefully this cycle`,
      );
    }
  } catch (err) {
    // A detection failure (remote read, probe) is not a cycle failure —
    // the same fail-open stance as pr-preflight: a lookup outage must
    // never block work.
    trace(`work-driver: forge detection failed: ${(err as Error).message?.slice(0, 160)}`);
    forge = undefined;
  }
  cache.set(key, forge);
  return forge;
}
