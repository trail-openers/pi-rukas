/**
 * lean/build — the step that dispatches ONE developer to make the frozen
 * acceptance tests pass.
 *
 * Where `specify` is an adversary writing tests nobody has implemented, `build`
 * is a builder writing the implementation against tests that already exist and
 * are already committed. The step itself writes no code and runs no tests:
 * `verify` is a separate step and re-runs the frozen files itself, so a build
 * that claimed "green" would be a builder grading its own homework. What build
 * owns is the boundary around the child — the tree it hands the child, the
 * prompt it gets, and the single commit that comes out the other side.
 *
 * The whole handler is: read the record, prove the tree, dispatch, normalise,
 * commit. In order, because each stage exists so the next one cannot be fooled:
 *
 *   1. **The frozen map comes from the step log**, not from a closure: the
 *      union, in order, of the `frozen` maps of every decided `specify:ok` and
 *      `challenge:new-tests` step. A resumed run sees what a crashed run froze,
 *      and a challenge round's new tests join the contract rather than sitting
 *      beside it.
 *   2. **The worktree must be the run's own** — registered, on the run's
 *      branch, and sitting at the head the frozen records were hashed at.
 *      Checked against that head rather than the base, because `specify` put a
 *      commit on top of the base and that commit IS the contract now.
 *   3. **The preconditions run before the dispatch**, so a model is never paid
 *      to work in a tree the step cannot account for: the frozen map is
 *      non-empty and every frozen blob at that head still hashes to its record.
 *   4. **One child**, role `developer`, fenced to the worktree. A child that
 *      died is infrastructure and throws; it is not a verdict about the work.
 *   5. **Normalise and commit** (`build-normalise.ts`): CAPTURE the child's
 *      files, RESET the tree to `headBefore` — which undoes its commits, its
 *      staging, every frozen edit and every protected-path edit — then REWRITE
 *      the captured bytes and make one provable commit. The git probes live in
 *      `build-git.ts`, the single-descriptor read in `build-capture.ts`, and
 *      the child in `build-dispatch.ts`.
 *   6. A child that produced nothing is `exhausted`, which the table routes —
 *      not a throw, and not a green.
 *
 * The re-entry context is read from the log too: the newest decided `verify:red`
 * reason, else the newest `ci:red`, clipped to 4 KB. That is the difference
 * between a fix round that knows what failed and a second attempt that guesses.
 */

import { existsSync } from "node:fs";
import { execp } from "../exec.ts";
import { spawnSpecialist } from "../spawn.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchSpec } from "../types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { dispatchBuilder } from "./build-dispatch.ts";
import { BuildInfraError } from "./build-errors.ts";
import { headSha } from "./build-git.ts";
import { assertFrozenIntact, normaliseBuild } from "./build-normalise.ts";
import type { BuildDispatch, BuildExec } from "./build-types.ts";
import { leanChildOpts } from "./child-opts.ts";
import type { WorkConfig } from "./config.ts";
import { loadWorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { type PiSpec, parsePiSpec } from "./spec.ts";
import { CaptureBudget } from "./specify-capture.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { Outcome, Step } from "./state.ts";
import {
  type BudgetArms,
  type BudgetOpts,
  armBudget,
  budgetFor,
  budgetVerdict,
  readDispatched,
} from "./step-budget.ts";

/** The re-entry reason the child is given, clipped so a log dump cannot bloat a prompt. */
const REENTRY_CLIP = 4096;

export interface BuildDeps {
  exec: BuildExec;
  dispatch: BuildDispatch;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  /** The aggregate capture ceiling in bytes; absent, the production ceiling applies. */
  captureCeiling?: number;
}

/** The step log's frozen map: every `specify:ok` / `challenge:new-tests`, in order. */
export function frozenFromLog(steps: Step[]): Record<string, string> {
  const frozen: Record<string, string> = {};
  for (const step of steps) {
    if (step.outcome === undefined) continue;
    const decided =
      (step.state === "specify" && step.outcome.kind === "ok") ||
      (step.state === "challenge" && step.outcome.kind === "new-tests");
    if (!decided) continue;
    for (const [rel, sha] of Object.entries(step.outcome.frozen ?? {})) frozen[rel] = sha;
  }
  return frozen;
}

/**
 * Why this round exists, in the gate's own words: the newest decided
 * `verify:red` reason, or the newest `ci:red` one, clipped.
 */
export function reentryFromLog(steps: Step[]): string | undefined {
  for (const state of ["verify", "ci"] as const) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step?.state !== state || step.outcome?.kind !== "red") continue;
      const reason = step.outcome.reason ?? step.outcome.message;
      if (typeof reason !== "string" || reason.trim() === "") continue;
      return reason.length > REENTRY_CLIP ? `${reason.slice(0, REENTRY_CLIP)}…` : reason;
    }
  }
  return undefined;
}

/** The spec, re-read from the forge. A build against a spec nobody re-read is a build against a fiction. */
async function specOf(deps: BuildDeps, repoRoot: string, issue: number): Promise<PiSpec> {
  let body: string;
  try {
    body = await deps.fetchIssueBody(repoRoot, issue);
  } catch (err) {
    throw new BuildInfraError(`could not read the issue: ${(err as Error).message}`);
  }
  const parsed = parsePiSpec(body);
  if (!parsed.ok) throw new BuildInfraError(`the issue's spec is unusable: ${parsed.reason}`);
  return parsed.spec;
}

/** The `build` step. Returns `ok` | `exhausted`; THROWS on infrastructure. */
export async function buildOutcome(ctx: HandlerCtx, deps: BuildDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;

  // 1. The contract, read out of the run's own record.
  const frozen = frozenFromLog(ctx.steps);

  // 2. The tree, and the head it is supposed to be at.
  const wt = specifyWorktreePath(repoRoot, issue);
  if (!existsSync(wt)) throw new BuildInfraError(`the worktree ${wt} does not exist`);
  const branch = specifyBranch(ctx.run.branch, issue);
  const base = ctx.run.baseSha;
  try {
    assertSafeRef(branch);
    if (base.trim() !== "") assertSafeRef(base);
  } catch (err) {
    throw new BuildInfraError((err as Error).message);
  }
  const headBefore = await headSha(deps.exec, wt);
  try {
    // Ownership, checked against the head the frozen records were hashed at
    // rather than the base: `specify` committed the tests on top of the base,
    // and a tree sitting anywhere else is not this run's to write into.
    await assertSpecifyWorktreeOwned(deps.exec, {
      repoRoot,
      wt,
      baseSha: base,
      branch,
      headMustBe: headBefore,
    });
  } catch (err) {
    throw new BuildInfraError((err as Error).message);
  }

  // 3. The preconditions, BEFORE the child is paid.
  await assertFrozenIntact(deps.exec, wt, headBefore, frozen);

  // A config the step cannot read is infrastructure: the developer would build
  // without the runner the project named, and that is not a verdict on the work.
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new BuildInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const spec = await specOf(deps, repoRoot, issue);
  const attempt =
    ctx.steps.filter((s) => s.state === "build" && s.outcome !== undefined).length + 1;

  // 4. The builder, under the state's budget (#1883). A breach is a routed
  //    verdict; the child's work goes back with the tree, nothing is committed.
  const reentry = reentryFromLog(ctx.steps);
  const budget = armBudget(budgetFor(config, "build"));
  if (budget.warning !== undefined) traceWarn(`lean build #${String(issue)}: ${budget.warning}`);
  const built = await dispatchBuilder(deps.dispatch, {
    issue,
    spec,
    frozen,
    wt,
    repoRoot,
    attempt,
    testRunner: config.verify.test,
    budget,
    ...(reentry === undefined ? {} : { reentry }),
  });
  const read = readDispatched(built);
  if ("stop" in read) return budgetVerdict("build", read.stop);

  // 5 + 6. Capture, reset, rewrite, commit — or say there was nothing to commit.
  const report = await normaliseBuild({
    exec: deps.exec,
    wt,
    repoRoot,
    branch,
    headBefore,
    frozen,
    attempt,
    issue,
    budget: new CaptureBudget(deps.captureCeiling),
  });
  if (report.files.length === 0)
    return { kind: "exhausted", reason: "the developer produced no change" };
  const notes = [
    `${report.files.length} file(s) changed`,
    report.restored.length > 0 ? `restored: ${report.restored.join(", ")}` : "",
    report.reverted.length > 0 ? `reverted: ${report.reverted.join(", ")}` : "",
    report.removed.length > 0
      ? `removed: ${report.removed.map((r) => `${r.path} (${r.why})`).join(", ")}`
      : "",
    report.deleted.length > 0 ? `deleted: ${report.deleted.join(", ")}` : "",
  ].filter((s) => s !== "");
  return { kind: "ok", reason: notes.join("; ") };
}

/** The build step's dependencies: the outside world, injected. */
export function buildDeps(headless: boolean): BuildDeps {
  return {
    exec: (cmd: string, o?: Parameters<ExecFn>[1]) => execp(cmd, o ?? {}),
    dispatch: (
      spec: DispatchSpec,
      o: { writeFence?: WriteFence; extraArgs?: readonly string[] } & BudgetOpts,
    ) =>
      spawnSpecialist(spec, {
        writeFence: o.writeFence,
        extraArgs: o.extraArgs,
        // Forwarded so the ceiling binds the child.
        childBoundMs: o.childBoundMs,
        signal: o.signal,
        onProgress: o.onProgress,
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
  };
}
