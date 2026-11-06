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
 *   2. **The worktree must be the run's own** — registered, on the run's branch,
 *      and sitting at the head the frozen records were hashed at, not the base:
 *      the commit `specify` put on top of it IS the contract now.
 *   3. **The preconditions run before the dispatch**, so a model is never paid to
 *      work in a tree the step cannot account for: the frozen map is non-empty and
 *      every frozen blob at that head still hashes to its record.
 *   4. **One child**, role `developer`, fenced to the worktree. A child that
 *      died is infrastructure and throws; it is not a verdict about the work.
 *   5. **Normalise and commit** (`build-normalise.ts`): CAPTURE the child's files,
 *      RESET the tree to `headBefore` — undoing its commits, its staging, every
 *      frozen and protected-path edit — then REWRITE the captured bytes and make
 *      one provable commit.
 *   6. A child that produced nothing is `exhausted`, which the table routes —
 *      not a throw, and not a green. A child its OWN ceiling stopped is
 *      `budget`: its work is folded and committed, and the step retries it in place
 *      while the round budget allows.
 *
 * The re-entry context comes from the log too, clipped to 4 KB: the newest decided
 * `verify:red`, else `ci:red`, else the newest `build:budget` — what its ceiling
 * cut off and the frozen files that step re-ran red.
 */

import { existsSync } from "node:fs";
import { execp } from "../exec.ts";
import { spawnSpecialist } from "../spawn.ts";
import { trace, traceWarn } from "../trace.ts";
import type { DispatchSpec } from "../types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { foldStoppedBuild, judgeBlockedReport } from "./build-blocked.ts";
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
import { MAX_BUILD_ATTEMPTS } from "./machine.ts";
import { type PiSpec, parsePiSpec } from "./spec.ts";
import { CaptureBudget } from "./specify-capture.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { Outcome, Step } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import {
  type BudgetOpts,
  armBudget,
  budgetFor,
  budgetSentence,
  budgetVerdictWithRows,
  readDispatched,
} from "./step-budget.ts";
import { clipList } from "./text-fence.ts";

/** The re-entry reason the child is given, clipped so a log dump cannot bloat a prompt. */
const REENTRY_CLIP = 4096;

/** How many names one reason line lists, and how many the fold re-runs. */
const LIST_CLIP = 20;

export interface BuildDeps {
  exec: BuildExec;
  dispatch: BuildDispatch;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  /** The aggregate capture ceiling in bytes; absent, the production ceiling applies. */
  captureCeiling?: number;
  /** The bound on the driver's re-runs of a frozen test — the blocked report's loop
   * and the stopped build's sweep alike. A test shortens it to watch a hang. */
  blockedTimeoutMs?: number;
}

/** Is this step one that froze tests: a decided `specify:ok` or `challenge:new-tests`. */
function frozeTests(step: Step): boolean {
  return (
    (step.state === "specify" && step.outcome?.kind === "ok") ||
    (step.state === "challenge" && step.outcome?.kind === "new-tests")
  );
}

/** The step log's frozen map: every `specify:ok` / `challenge:new-tests`, in order. */
export function frozenFromLog(steps: Step[]): Record<string, string> {
  const frozen: Record<string, string> = {};
  for (const step of steps.filter(frozeTests))
    for (const [rel, sha] of Object.entries(step.outcome?.frozen ?? {})) frozen[rel] = sha;
  return frozen;
}

/**
 * The criterion -> tests map, unioned over every step that recorded one. The
 * run-level file quota seeds from here: `MAX_TEST_FILES_PER_CRITERION` bounds
 * what a criterion ENDS UP WITH across the run, and only this map knows what an
 * earlier round already froze for it. Same decided outcomes as `frozenFromLog`.
 */
export function testsFromLog(steps: Step[]): Record<string, string[]> {
  const tests: Record<string, string[]> = {};
  for (const step of steps.filter(frozeTests)) {
    for (const [id, files] of Object.entries(step.outcome?.tests ?? {})) {
      const seen = new Set(tests[id] ?? []);
      for (const f of files) seen.add(f);
      tests[id] = [...seen];
    }
  }
  return tests;
}

/** The `; `-joined non-empty parts of a reason line. */
function joinNotes(parts: string[]): string {
  return parts.filter((p) => p !== "").join("; ");
}

/** The newest decided `state` + `kind` step's reason, clipped for a prompt. */
function reasonFromLog(
  steps: Step[],
  state: "verify" | "ci" | "build",
  kind: "red" | "budget",
): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const oc = steps[i]?.state === state ? steps[i]?.outcome : undefined;
    if (oc?.kind !== kind) continue;
    const reason = oc.reason ?? oc.message;
    if (typeof reason !== "string" || reason.trim() === "") continue;
    return reason.length > REENTRY_CLIP ? `${reason.slice(0, REENTRY_CLIP)}…` : reason;
  }
  return undefined;
}

/**
 * Why this round exists, in the gate's own words: the newest decided `verify:red`,
 * else the newest `ci:red`, clipped. A round that came back from added tests is
 * told by {@link addedByChallengeFromLog} instead.
 */
export function reentryFromLog(steps: Step[]): string | undefined {
  return reasonFromLog(steps, "verify", "red") ?? reasonFromLog(steps, "ci", "red");
}

/**
 * What stopped the PREVIOUS attempt and what still fails: the newest decided
 * `build:budget` reason, which that step composed from its ceiling and the files
 * it re-ran red. No gate judged a killed builder, so `reentryFromLog` is silent
 * and a child told only "the last round stopped" re-derives the feature.
 */
function budgetStopFromLog(steps: Step[]): string | undefined {
  return reasonFromLog(steps, "build", "budget");
}

/**
 * What the adversary added, in the builder's own brief: the frozen paths of the
 * newest decided `challenge:new-tests` step. No gate judged them — the adversary
 * only made the contract bigger — so they are named rather than quoted.
 */
export function addedByChallengeFromLog(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "challenge" || step.outcome?.kind !== "new-tests") continue;
    const paths = Object.keys(step.outcome.frozen ?? {});
    if (paths.length === 0) continue;
    const kept = paths.slice(0, LIST_CLIP).map((p) => `- \`${p}\``);
    const more = paths.length > LIST_CLIP ? `\n- …and ${paths.length - LIST_CLIP} more` : "";
    const line = `the adversary's challenge round added these frozen tests:\n${kept.join("\n")}${more}`;
    return line.length > REENTRY_CLIP ? `${line.slice(0, REENTRY_CLIP)}…` : line;
  }
  return undefined;
}

/** The spec, re-read from the forge: a build against an unread spec is fiction. */
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

/** The `build` step. Returns `ok` | `exhausted` | `blocked`; THROWS on infrastructure. */
export async function buildOutcome(ctx: HandlerCtx, deps: BuildDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;

  // 1. The contract, out of the run's own record.
  const frozen = frozenFromLog(ctx.steps);

  // 2. The tree and the head it must sit at.
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
    // Ownership against the head the frozen records were hashed at, not the base.
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

  // 3. The preconditions, BEFORE the child is paid. A config the step cannot read
  //    is infrastructure: building without the runner the project named is not a
  //    verdict on the work.
  await assertFrozenIntact(deps.exec, wt, headBefore, frozen);
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new BuildInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const spec = await specOf(deps, repoRoot, issue);
  const attempt =
    ctx.steps.filter((s) => s.state === "build" && s.outcome !== undefined).length + 1;

  // 4. The builder, under the state's budget (#1883). A child that died THROWS, so
  //    the rows ride on the error to the outcome the engine writes (#1920 A). A
  //    child its OWN ceiling stopped is retried HERE — the table has no `build`
  //    self-edge — and its work rides forward on the commit its fold made.
  // The tree, head and contract every fold of this attempt is judged against.
  const fold = (attempt: number) => ({
    exec: deps.exec,
    wt,
    repoRoot,
    branch,
    headBefore,
    frozen,
    attempt,
    issue,
  });
  const reentry = reentryFromLog(ctx.steps);
  const added = addedByChallengeFromLog(ctx.steps);
  let stopped = budgetStopFromLog(ctx.steps);
  const rows: DispatchUsageRow[] = [];
  let toolUses: unknown[] = [];
  for (let tries = 0; ; tries++) {
    const budget = armBudget(budgetFor(config, "build"));
    if (budget.warning !== undefined) traceWarn(`lean build #${String(issue)}: ${budget.warning}`);
    const [dispatched, row] = await dispatchBuilder(deps.dispatch, {
      issue,
      spec,
      frozen,
      wt,
      repoRoot,
      attempt,
      testRunner: config.verify.test,
      budget,
      ...(reentry === undefined ? {} : { reentry }),
      ...(added === undefined ? {} : { added }),
      ...(stopped === undefined ? {} : { budgetStop: stopped }),
    });
    rows.push(row);
    const read = readDispatched(dispatched);
    if (!("stop" in read)) {
      toolUses = read.result.toolUses ?? [];
      break;
    }
    // Its own ceiling stopped it: fold the work into this attempt's commit and
    // re-run the frozen files under ONE wall clock, so verify finds a clean tree and
    // the retry's prompt names what is still failing (#2067). The kind stays `budget`.
    // R5: a run the cap ENDS here names the attempts too, which `handback` prints —
    // a ceiling alone cannot say the retries were spent.
    const attempts = ctx.run.counters.buildAttempts + tries + 1;
    const atCap = attempts >= MAX_BUILD_ATTEMPTS;
    const { kept, failing } = await foldStoppedBuild({
      ...fold(attempt),
      template: config.verify.test,
      ceiling: deps.captureCeiling,
      ...(deps.blockedTimeoutMs === undefined ? {} : { timeoutMs: deps.blockedTimeoutMs }),
    });
    // The line the step log, handback and the retry's prompt all read (R3/R5).
    const verdict: Outcome = {
      ...budgetVerdictWithRows("build", read.stop, rows),
      reason: joinNotes([
        budgetSentence("build", read.stop),
        ...(atCap ? [`after ${String(attempts)} build attempts`] : []),
        failing.length === 0 ? "" : `still failing: ${clipList(failing, LIST_CLIP)}`,
        kept.files.length === 0 ? "" : `kept ${String(kept.files.length)} file(s)`,
      ]),
    };
    stopped = verdict.reason;
    if (atCap) return verdict;
  }

  // 4b. The child's own "these cannot all pass together", if it made one: a CLAIM,
  //     honoured only once the driver ran the named frozen tests on its tree and saw
  //     one come back red. An ignored report traces a line and records nothing.
  const blocked = await judgeBlockedReport({
    exec: deps.exec,
    wt,
    template: config.verify.test,
    frozen,
    toolUses,
    issue,
    ...(deps.blockedTimeoutMs === undefined ? {} : { timeoutMs: deps.blockedTimeoutMs }),
  });
  if (blocked !== undefined) {
    // No commit: `verify` never judges a tree this step cannot account for.
    return {
      kind: "blocked",
      reason: blocked.reason,
      blockedBy: blocked.blockedBy,
      dispatches: rows,
    };
  }

  // 5 + 6. Capture, reset, rewrite, commit — or say there was nothing to commit.
  const report = await normaliseBuild({
    ...fold(attempt),
    budget: new CaptureBudget(deps.captureCeiling),
  });
  if (report.files.length === 0)
    return { kind: "exhausted", reason: "the developer produced no change", dispatches: rows };
  return {
    kind: "ok",
    reason: joinNotes([
      `${String(report.files.length)} file(s) changed`,
      report.restored.length > 0 ? `restored: ${report.restored.join(", ")}` : "",
      report.reverted.length > 0 ? `reverted: ${report.reverted.join(", ")}` : "",
      report.removed.length > 0
        ? `removed: ${report.removed.map((r) => `${r.path} (${r.why})`).join(", ")}`
        : "",
      report.deleted.length > 0 ? `deleted: ${report.deleted.join(", ")}` : "",
    ]),
    dispatches: rows,
  };
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
        // Forwarded so the ceiling binds the child; `budgetTurns` is the same
        // ceiling the #1991 budget-progress steer counts down from.
        childBoundMs: o.childBoundMs,
        signal: o.signal,
        onProgress: o.onProgress,
        budgetTurns: o.budgetTurns,
        // The budget's kill goes through `killProcessTree`, which only reaches the
        // child's tool tree when the child leads its own group.
        processGroup: true,
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
  };
}
