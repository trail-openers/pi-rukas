/**
 * lean/build-dispatch — the one child the build step pays for, and the throw a
 * dead child deserves.
 *
 * `build` dispatches a single `developer` fenced to the run's worktree. A child
 * that died mid-stream is infrastructure, not a verdict about the work: it is
 * never `exhausted` (which would route the machine onward as though the
 * developer had tried and produced nothing) and never `ok`. ONE child is not:
 * a child that died before its first turn is handed back for a single free
 * re-dispatch, and the taxonomy — not this module — decides which deaths
 * qualify. The prompt itself is assembled in `build-prompt.ts` so this module
 * owns only the seam.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { statReporterPath } from "../reporter-preflight.ts";
import type { DispatchResult } from "../types.ts";
import { BLOCKED_REPORTER_PATH } from "./build-blocked-reporter.ts";
import { BuildInfraError } from "./build-errors.ts";
import { buildPrompt } from "./build-prompt.ts";
import type { BuildDispatch } from "./build-types.ts";
import { dispatchFailureWhy, throwIfDispatchFailed } from "./dispatch-verdict.ts";
import { type ProviderWaitClass, providerFaultOf } from "./provider-wait.ts";
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
  /** Why this round exists: the `verify:red` or `ci:red` reason, if any. */
  reentry?: string;
  /** The previous attempt's budget stop and what is still failing, if it was one. */
  budgetStop?: string;
  /**
   * What the adversary's challenge round added, if it added anything: the frozen
   * paths it froze, named so this round knows which files are new to it.
   */
  added?: string;
  /** The step's budget arms, armed before the child and read back after. */
  budget: BudgetArms;
  /**
   * The stat the companion preflight runs; `fs/promises.stat` in production.
   * Injectable the way `specify`/`challenge` inject it, so a case can fail the
   * check without touching the filesystem — and the preflight's own named error
   * is what the case observes, not a stand-in for it.
   */
  statReporter?: (p: string) => Promise<unknown>;
}

/**
 * A builder that died before doing any work, which the step may re-dispatch.
 *
 * dispatchBuilder is the only site holding the child's DispatchResult, so it
 * is the only site that can tell a child that did nothing from one that died
 * mid-flight; the caller sees only the row, which keeps no toolUses. A kill or
 * a terminal provider fault never becomes this: `providerFaultOf` declines it.
 * The classification it took to say so rides along, so the wait site never
 * classifies the same death twice.
 */
interface NoWorkCrash {
  readonly noWorkCrash: true;
  /** Why the first child failed, for the throw the step still may have to make. */
  why: string;
  row: DispatchUsageRow;
  /** The classifier's verdict on this death, carried out of the one call. */
  cls: ProviderWaitClass;
}

/**
 * The taxonomy's kind for a `DispatchResult`: the endpoint's own error stop is a
 * provider event, anything else is a plain crash. A killed child stays on
 * `dispatch-failed` — a self-kill is never a provider failure, and that
 * is the ONLY kind `terminalProviderClassOnKill` reads, so labelling a kill
 * provider-shaped switches off the override that makes a spend cap fatal.
 */
export function failureKindFor(result: DispatchResult): string {
  return result.killCause === undefined && result.errorStop !== undefined
    ? "dispatch-failed-provider"
    : "dispatch-failed";
}

/**
 * True only on POSITIVE evidence that the child did nothing: turns are a known
 * number and no turn did any work (`<= 1`), and no tool call is reported or was
 * seen live. Unknown usage is not evidence of an empty child.
 */
export function didNoWork(result: DispatchResult): boolean {
  return (
    result.usage !== undefined &&
    result.usage.turns <= 1 &&
    result.toolUses.length === 0 &&
    (result.observedToolCalls ?? 0) === 0
  );
}

/**
 * Dispatch one developer. A budget breach comes back as {@link BudgetStop}, a
 * dead-but-idle child the taxonomy calls transient as {@link NoWorkCrash};
 * every other dead child — killed, quota-stopped, or one that worked — is still
 * infrastructure and throws.
 *
 * The second element of the pair is the row this dispatch cost, and it is
 * returned on every path that RECEIVED a `DispatchResult` — the ok path, the
 * budget stop, and the infra throw built from that result. A throw from before
 * the result arrived (the dispatch seam rejecting, for instance) saw no child
 * and carries no row. A child that died mid-stream spent its tokens before
 * anybody knew, and the caller has no way to build the row after a throw.
 */
export async function dispatchBuilder(
  dispatch: BuildDispatch,
  opts: BuildDispatchOpts,
): Promise<[DispatchResult | BudgetStop | NoWorkCrash, DispatchUsageRow]> {
  await statReporterPath(BLOCKED_REPORTER_PATH, opts.statReporter ?? stat);
  const prompt = buildPrompt({
    issue: opts.issue,
    spec: opts.spec,
    frozenPaths: Object.keys(opts.frozen),
    worktree: opts.wt,
    attempt: opts.attempt,
    ...(opts.testRunner === undefined ? {} : { testRunner: opts.testRunner }),
    ...(opts.reentry === undefined ? {} : { reentry: opts.reentry }),
    ...(opts.budgetStop === undefined ? {} : { budgetStop: opts.budgetStop }),
    ...(opts.added === undefined ? {} : { added: opts.added }),
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
      extraArgs: ["--no-skills", "--extension", BLOCKED_REPORTER_PATH],
    },
  );
  // The row is built from what the child REPORTED, before either branch below
  // decides what the child MEANT — so a budget stop and an infra throw carry it
  // too.
  const row = dispatchUsageRow(result);
  // Before the throw below: the step's own ceiling ending the child is a verdict.
  const fired = opts.budget.fired(result);
  if (fired !== undefined) return [budgetStop(fired), row];
  // Before the shared tail: a child that provably did nothing is a re-dispatch,
  // not a verdict, so it comes back as a row rather than a throw. `providerFaultOf`
  // is the only answer that declines a cap — a kill and a terminal provider fault
  // (spend cap, quota window, undated 429, missing model) both come back undefined.
  if (!result.ok || result.killCause !== undefined || result.errorStop !== undefined) {
    const cls = didNoWork(result) ? providerFaultOf(result) : undefined;
    if (cls !== undefined)
      return [{ noWorkCrash: true as const, why: dispatchFailureWhy(result), row, cls }, row];
  }
  throwIfDispatchFailed(result, BuildInfraError, "build dispatch failed: ", [row]);
  return [result, row];
}
