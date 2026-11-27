/**
 * oracle-repair-wiring — the production outside world for the one repair round a run may buy.
 *
 * Built here rather than in `lean/command.ts` for the same reason the rest of the round lives outside the
 * engine directory: this is plumbing over the host (`spawnSpecialist`, the throwaway base checkout, the config
 * loader), not engine state. `command.ts` asks for it the way it asks for `buildDeps(headless)` — one call,
 * one line in the handler table.
 *
 * The base checkout is the judge's stage, so it follows `verify-baseline.ts`'s discipline exactly: registered
 * under the repo's `.worktrees/` at a path no other step uses, removed before the add and again in a
 * `finally`, because a registration a killed run left behind makes the next `worktree add` at that path
 * refuse. It is created ONCE per step and passed down, so a round that judges two files does not pay for two
 * checkouts.
 */
import { execp } from "./exec.ts";
import { spawnSpecialist } from "./spawn.ts";
import type { DispatchSpec } from "./types.ts";
import { leanChildOpts } from "./lean/child-opts.ts";
import { NO_HOOKS } from "./lean/specify-reset.ts";
import { ensureSpecifyWorktreeWithProvision } from "./lean/specify-tree.ts";
import { type WorkConfig, loadWorkConfig } from "./lean/config.ts";
import { fetchIssueBody } from "./lean/io.ts";
import type { BudgetOpts } from "./lean/step-budget.ts";
import type { RepairDeps } from "./lean/repair.ts";
import type { BuildExec } from "./lean/build-types.ts";
import type { WriteFence } from "./write-fence-contract.ts";
import { verifyHostEnv } from "./work-driver-verify-cmd.ts";
import { traceWarn } from "./trace.ts";

/** Where the judge's throwaway base checkout lives, one path per issue so two runs cannot share one. */
export function repairBaseTreePath(repoRoot: string, issue: number): string {
  return `${repoRoot}/.worktrees/lean-${String(issue)}-repair-base`;
}

/** The judge's checkout: created detached at the run's base, removed whatever the round decided. */
export async function withRepairBaseTree<T>(
  exec: BuildExec,
  repoRoot: string,
  issue: number,
  baseSha: string,
  fn: (tree: string) => Promise<T>,
): Promise<T> {
  const abs = repairBaseTreePath(repoRoot, issue);
  const hostEnv = verifyHostEnv();
  const remove = () =>
    exec("git", {
      argv: [...NO_HOOKS, "worktree", "remove", "--force", abs],
      cwd: repoRoot,
      timeout: 60_000,
      maxBuffer: 256 * 1024,
      env: hostEnv,
    }).catch(() => undefined);
  await remove();
  try {
    await exec("git", {
      argv: [...NO_HOOKS, "worktree", "add", "--detach", abs, baseSha],
      cwd: repoRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: hostEnv,
    });
    return await fn(abs);
  } finally {
    await remove().catch((err: unknown) =>
      traceWarn(`lean repair: base tree cleanup failed: ${(err as Error)?.message ?? String(err)}`),
    );
  }
}

/** The `repair` step's production deps, built with THIS run's trust stamp.
 *
 * `repoRoot` and `issue` are passed in because the base tree's path is derived from both, and the step's
 * `HandlerCtx` — where they live — belongs to the caller.
 */
export function repairDeps(
  headless: boolean,
  repoRoot: string,
  issue: number,
  baseSha: () => string,
): RepairDeps {
  const exec: BuildExec = (cmd, o) => execp(cmd, o ?? {});
  return {
    exec,
    dispatch: (
      spec: DispatchSpec,
      o: { writeFence?: WriteFence; extraArgs?: readonly string[] } & BudgetOpts,
    ) =>
      spawnSpecialist(spec, {
        writeFence: o.writeFence,
        extraArgs: o.extraArgs,
        // Forwarded so the ceiling binds the child: the bound, its grace, the abort and the
        // progress stream are what make a budget real at the far end of the seam.
        childBoundMs: o.childBoundMs,
        childBoundGraceMs: o.childBoundGraceMs,
        signal: o.signal,
        onProgress: o.onProgress,
        budgetTurns: o.budgetTurns,
        ...(o.stall === undefined ? {} : { stall: o.stall }),
        // The budget's kill reaches the child's tool tree only when the child leads its own group.
        processGroup: true,
        ...leanChildOpts(headless),
      }),
    ensureTree: (o) => ensureSpecifyWorktreeWithProvision(exec, o),
    withBaseTree: (fn) => withRepairBaseTree(exec, repoRoot, issue, baseSha(), fn),
    loadConfig: (root, sha) => loadWorkConfig(execp, root, sha),
    fetchIssueBody,
  };
}
