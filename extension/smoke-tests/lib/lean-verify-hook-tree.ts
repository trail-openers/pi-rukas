/**
 * lib/lean-verify-hook-tree — the hook-provisioned half of the verify fixture.
 *
 * One case needs to know WHERE the project's `.pi/worktree-setup` ran: the baseline probe
 * must never execute it against a throwaway base checkout, while the run's own worktree must
 * still be provisioned by it. The only honest evidence is the hook writing a marker itself,
 * so the hook is given a directory to mark and the case reads that directory back.
 *
 * This lives apart from `lean-verify-fixture.ts` because it is the seam into the driver's
 * real provisioning: the fixture's tree is built with plain git, so the hook has to be run
 * here by hand — through `provisionWorktree`, the same call the branch step makes — for
 * "the hook ran in the run's tree" to be a fact rather than an assumption.
 */

import { execp } from "../../src/exec.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** The env a hook-provisioned case passes down so the project's `.pi/worktree-setup` can
 * say WHERE it ran: the script writes a marker into this directory, and the case reads the
 * directory back to see which trees provisioning reached. */
export function hookMarksEnv(marksDir: string): Record<string, string> {
  return { PI_RUKAS_TEST_HOOK_MARKS: marksDir };
}

/** What building a fixture yields: the repo, its worktree, the frozen record and the ctx. */
export interface Fixture {
  repoRoot: string;
  wt: string;
  head: string;
  ctx: import("../../src/lean/engine.ts").HandlerCtx;
  frozen: Record<string, string>;
}

/** The hook a case puts in the repo, and where it marks the trees it reached. */
export interface HookAtBase {
  script: string;
  marksDir: string;
}

/**
 * Provision the fixture's own worktree through the project hook.
 *
 * The fixture builds that tree with plain git, so the driver's provisioning never ran for
 * it. Running the hook here by hand is what makes a hook that DID run in the run's tree the
 * baseline the probe case compares against — and its absence in the probe's tree means
 * something rather than merely proving nothing.
 */
export async function provisionHookedTree(
  built: Fixture,
  hook: HookAtBase,
  gitIdentity: Record<string, string>,
): Promise<void> {
  const { provisionWorktree } = await import("../../src/worktree-provision.ts");
  await provisionWorktree(
    (cmd, o2) =>
      execp(cmd, {
        cwd: o2?.cwd,
        maxBuffer: o2?.maxBuffer,
        argv: o2?.argv,
        env: { ...gitTestEnv(), ...gitIdentity, ...hookMarksEnv(hook.marksDir) },
      }),
    built.repoRoot,
    built.wt,
  );
}
