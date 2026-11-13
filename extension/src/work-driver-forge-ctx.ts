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
 *   - the forge is DETECTED, never asserted. `resolveCycleForge` is the
 *     single guarded detection the whole classic driver and its sibling
 *     resolvers go through, so a cycle on a GitLab project gets the GitLab
 *     adapter and a cycle on a repo whose forge nothing can name gets
 *     `undefined`.
 *
 * What "fail-CLOSED" means here, precisely: an unnameable forge yields
 * `undefined`, never a guess. It is not a cycle-killer — every consumer falls
 * back to its existing no-forge behaviour (git-only mainline resolution, a
 * named refusal instead of a `gh` call, …). A forge outage must not block
 * work any more than a `gh` outage does.
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
 * The ONE guarded forge detection the classic driver and its sibling resolvers
 * share (F7): the same question, answered the same way, from the same repo.
 *
 * The three rules, and why each is load-bearing:
 *
 *  - `PI_ENSEMBLE_FORGE=none` short-circuits BEFORE detection. The offline
 *    suite turns the forge off that way (~35 smoke tests); `detectForge`
 *    reads an unrecognised value as "fall through to the remote", so skipping
 *    the short-circuit would put a real remote read in front of every one of
 *    them.
 *  - `allowProbe: false`. The driver's fake exec seams answer only the
 *    commands the step under test cares about, and a cycle's cwd is whatever
 *    the fixture made. A probe against a fake cwd is exactly the side effect
 *    an offline cycle must not take, and the probe only fires for hosts the
 *    known-host table does not already classify — so the offline answer is
 *    unchanged.
 *  - `unknown` → `undefined`. `createForge` refuses an unknown detection, and
 *    "I could not tell" is never a reason to pick a forge: a cycle that
 *    guessed GitHub would issue `gh` against a GitLab project.
 *
 * `traceLabel` names the resolution in the trace line WITH `det.source`, so an
 * operator reading `PI_ENSEMBLE_DEBUG=1` can tell "no remote" (`source:
 * unknown`, nothing read) from "a config was rejected" (the config's host
 * disagreed with the remote) — the two look identical from `undefined` alone.
 */
export async function resolveCycleForge(
  repoRoot: string,
  opts: {
    execFn?: VerifyExecFn;
    env?: Record<string, string | undefined>;
    traceLabel?: string;
  } = {},
): Promise<Forge | undefined> {
  if ((opts.env ?? process.env).PI_ENSEMBLE_FORGE === "none") return undefined;
  const label = opts.traceLabel ?? "cycle";
  try {
    const det: ForgeDetection = await detectForge(repoRoot, {
      allowProbe: false,
      ...(opts.env === undefined ? {} : { env: opts.env }),
      ...(opts.execFn === undefined ? {} : { execFn: opts.execFn as unknown as DetectForgeExecFn }),
    });
    if (det.forge === "unknown") {
      trace(
        `work-driver: ${label} forge detection ${det.source} (${det.forge}) — forge-less sites degrade gracefully`,
      );
      return undefined;
    }
    return createForge(det, {
      ...(opts.execFn === undefined ? {} : { execFn: opts.execFn as unknown as ForgeExecFn }),
      cwd: repoRoot,
    });
  } catch (err) {
    // A detection failure (remote read, probe) is not a cycle failure —
    // the same fail-open stance as pr-preflight: a lookup outage must
    // never block work.
    trace(`work-driver: ${label} forge detection failed: ${(err as Error).message?.slice(0, 160)}`);
    return undefined;
  }
}

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
  opts: {
    execOpts?: { timeout?: number; maxBuffer?: number };
    /** The environment detection reads (default `process.env`). Tests pass an
     *  object with the key ABSENT to mean "no override"; never assign
     *  `undefined` to `process.env`, which stores the string "undefined". */
    env?: Record<string, string | undefined>;
  } = {},
): Promise<Forge | undefined> {
  const key = ctx.repoRoot;
  if (cache.has(key)) return cache.get(key);
  // `execOpts` is the per-call deadline a caller carries into every adapter exec
  // (the explore issue-body fetch uses it for its per-attempt bound). Binding it
  // into the seam here keeps the adapter built once by the shared resolver while
  // still putting the caller's bound on every command it runs: an adapter with
  // no timeout is an unbounded `gh`.
  const boundExecFn: VerifyExecFn | undefined =
    opts.execOpts === undefined
      ? execFn
      : (cmd, execOpts) => execFn(cmd, { ...execOpts, ...opts.execOpts });
  const forge = await resolveCycleForge(ctx.repoRoot, {
    execFn: boundExecFn,
    env: opts.env,
    traceLabel: "cycle",
  });
  cache.set(key, forge);
  return forge;
}
