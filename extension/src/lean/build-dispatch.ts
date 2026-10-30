/**
 * lean/build-dispatch — the one child the build step pays for, and the throw a
 * dead child deserves.
 *
 * `build` dispatches a single `developer` fenced to the run's worktree. A child
 * that died mid-stream is infrastructure, not a verdict about the work: it is
 * never `exhausted` (which would route the machine onward as though the
 * developer had tried and produced nothing) and never `ok`. The prompt itself
 * is assembled in `build-prompt.ts` so this module owns only the seam.
 */

import path from "node:path";
import type { DispatchResult } from "../types.ts";
import { BuildInfraError } from "./build-errors.ts";
import { buildPrompt } from "./build-prompt.ts";
import type { BuildDispatch } from "./build-types.ts";
import type { PiSpec } from "./spec.ts";
import {
  type BudgetArms,
  type BudgetStop,
  type DispatchUsageRow,
  budgetStop,
  dispatchUsageRow,
} from "./step-budget.ts";

/** The prompt's inputs, gathered by `build.ts` from the step log and the forge. */
export interface BuildDispatchOpts {
  issue: number;
  spec: PiSpec;
  frozen: Record<string, string>;
  wt: string;
  repoRoot: string;
  attempt: number;
  /** The project's `verify.test` runner template (e.g. `bun run {file}`), if configured. */
  testRunner?: string;
  /** The verify-red / CI-red reason this round is a fix for, if any. */
  reentry?: string;
  /** The step's budget arms, armed before the child and read back after. */
  budget: BudgetArms;
}

/**
 * Dispatch one developer. A budget breach comes back as {@link BudgetStop}, not a
 * throw; any other dead child is still infrastructure.
 *
 * The second element of the pair is the row this dispatch cost, and it is
 * returned on EVERY path that observed a child — the ok path, the budget stop,
 * and the throw included. A child that died mid-stream spent its tokens before
 * anybody knew, and the caller has no way to build the row after a throw, so a
 * row dropped here is a cost the run's total silently forgets.
 */
export async function dispatchBuilder(
  dispatch: BuildDispatch,
  opts: BuildDispatchOpts,
): Promise<[DispatchResult | BudgetStop, DispatchUsageRow]> {
  const prompt = buildPrompt({
    issue: opts.issue,
    spec: opts.spec,
    frozenPaths: Object.keys(opts.frozen),
    worktree: opts.wt,
    attempt: opts.attempt,
    ...(opts.testRunner === undefined ? {} : { testRunner: opts.testRunner }),
    ...(opts.reentry === undefined ? {} : { reentry: opts.reentry }),
  });
  const result = await dispatch(
    { role: "developer", prompt, cwd: opts.wt },
    {
      writeFence: {
        root: opts.wt,
        repo: opts.repoRoot,
        // `<repoRoot>/tmp/lean-<issue>`: the worktree's parent is `.worktrees`,
        // so one `..` from it is the repo root — the scratch dir the scratch
        // hygiene convention names, inside the run's own clone.
        scratch: path.join(path.dirname(opts.wt), "..", "tmp", `lean-${opts.issue}`),
      },
      ...opts.budget.opts,
    },
  );
  // The row is built from what the child REPORTED, before either branch below
  // decides what the child MEANT — so a budget stop and an infra throw carry it
  // too.
  const row = dispatchUsageRow(result);
  // Before the throw below: the step's own ceiling ending the child is a verdict.
  const fired = opts.budget.fired(result);
  if (fired !== undefined) return [budgetStop(fired), row];
  if (!result.ok || result.killCause !== undefined || result.errorStop !== undefined) {
    const why =
      result.killCause ??
      result.errorStop?.message ??
      result.errorStop?.reason ??
      `exit ${String(result.exitCode)}`;
    throw new BuildInfraError(`build dispatch failed: ${String(why)}`, [row]);
  }
  return [result, row];
}
