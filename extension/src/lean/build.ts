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
 *      not a throw, and not a green. A child its OWN ceiling stopped is
 *      `budget`: its work is folded and committed first, and the step retries it
 *      in place while the round budget allows.
 *
 * The re-entry context is read from the log too: the newest decided `verify:red`
 * reason, else the newest `ci:red`, clipped to 4 KB — the difference between a
 * fix round that knows what failed and an attempt that guesses. The newest
 * `build:budget` step is read the same way, so a retry names what its ceiling cut
 * off and the frozen files that step re-ran red.
 */

import { existsSync } from "node:fs";
import { execp } from "../exec.ts";
import { spawnSpecialist } from "../spawn.ts";
import { trace, traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchSpec } from "../types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { extractBlockedReport } from "./build-blocked-extract.ts";
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
import { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP } from "./state-outcome.ts";
import type { Outcome, Step } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import {
  type BudgetArms,
  type BudgetOpts,
  type BudgetStop,
  armBudget,
  budgetFor,
  budgetSentence,
  budgetVerdictWithRows,
  readDispatched,
} from "./step-budget.ts";
import { oneLine } from "./text-fence.ts";

/** The re-entry reason the child is given, clipped so a log dump cannot bloat a prompt. */
const REENTRY_CLIP = 4096;

/** How of the adversary's files a re-entry line names. Beyond it, the count. */
const CHALLENGE_LIST_CLIP = 20;

/**
 * The ceiling on the recorded cause LINE: the two caps the renderers share (see
 * `state-outcome-maps.ts`) plus the fixed sentence around them, so the bound is
 * the sum of what this function composes rather than a fourth literal nothing
 * derives.
 */
const BLOCKED_CAUSE_CAP = BLOCKED_PATH_CAP + BLOCKED_REASON_CAP + 44;

export interface BuildDeps {
  exec: BuildExec;
  dispatch: BuildDispatch;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  /** The aggregate capture ceiling in bytes; absent, the production ceiling applies. */
  captureCeiling?: number;
  /**
   * The bound on each of the driver's re-runs of a reported frozen test. A test
   * shortens it to observe a hang; absent, `runTestFile`'s own ceiling applies.
   */
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

/** The `; `-joined non-empty parts of a step's reason line. */
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
 * Why this round exists, in the gate's own words: the newest decided `verify:red`
 * reason, or the newest `ci:red` one, clipped. A build that came back from a
 * `challenge` round which ADDED tests is told by {@link addedByChallengeFromLog}
 * instead — nobody judged those files, the adversary just froze them.
 */
export function reentryFromLog(steps: Step[]): string | undefined {
  return reasonFromLog(steps, "verify", "red") ?? reasonFromLog(steps, "ci", "red");
}

/**
 * What stopped the PREVIOUS attempt and what still fails: the newest decided
 * `build:budget` reason, which that step composed from its ceiling and the frozen
 * files it re-ran red. No gate judged a killed builder, so `reentryFromLog` has
 * nothing to say and a child told only "the last round stopped" re-derives the
 * feature from scratch.
 */
function budgetStopFromLog(steps: Step[]): string | undefined {
  return reasonFromLog(steps, "build", "budget");
}

/**
 * What the adversary added, in the builder's own brief: the frozen paths of the
 * newest decided `challenge:new-tests` step. A gate judged nothing here — the
 * adversary only made the contract bigger — so the files are named rather than a
 * complaint quoted. Same decided outcomes as `frozenFromLog`.
 */
export function addedByChallengeFromLog(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "challenge" || step.outcome?.kind !== "new-tests") continue;
    const paths = Object.keys(step.outcome.frozen ?? {});
    if (paths.length === 0) continue;
    const kept = paths.slice(0, CHALLENGE_LIST_CLIP).map((p) => `- \`${p}\``);
    const more =
      paths.length > CHALLENGE_LIST_CLIP
        ? `\n- …and ${paths.length - CHALLENGE_LIST_CLIP} more`
        : "";
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

  // 1. The contract, read out of the run's own record.
  const frozen = frozenFromLog(ctx.steps);

  // 2. The tree, and the head it must sit at.
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
  //    self-edge to route on — and its work rides forward on the commit its fold
  //    made, which is also where the retry and every later step start.
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
    // The child wrote code and its own ceiling stopped it: fold that work into
    // this attempt's commit and re-run the frozen files, so verify and ci find a
    // clean tree and the next child's prompt names what is still failing (#2067
    // R3/R4). The kind stays `budget` — a fold never turns a stop into an `ok`.
    const { kept, failing } = await foldStoppedBuild({
      exec: deps.exec,
      wt,
      repoRoot,
      branch,
      headBefore,
      frozen,
      attempt,
      issue,
      template: config.verify.test,
      ceiling: deps.captureCeiling,
    });
    // The per-attempt line the step log and handback print (R5). The retry's
    // prompt reads the same sentence (R3).
    const verdict: Outcome = {
      ...budgetVerdictWithRows("build", read.stop, rows),
      ...(failing.length === 0 ? {} : { failing }),
      reason: joinNotes([
        budgetSentence("build", read.stop),
        `still failing: ${failing.join(", ")}`,
        kept.files.length === 0 ? "" : `kept ${String(kept.files.length)} file(s)`,
      ]),
    };
    stopped = verdict.reason;
    if (ctx.run.counters.buildAttempts + tries + 1 >= MAX_BUILD_ATTEMPTS) return verdict;
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
    // No reset and no commit: `verify` is never asked to judge a tree this step
    // cannot account for.
    return {
      kind: "blocked",
      reason: blocked.reason,
      blockedBy: blocked.blockedBy,
      dispatches: rows,
    };
  }

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
        // Forwarded so the ceiling binds the child. `budgetTurns` is the same
        // ceiling the #1991 budget-progress steer counts down from, so a seam
        // that forwards the arms key by key must forward that one too.
        childBoundMs: o.childBoundMs,
        signal: o.signal,
        onProgress: o.onProgress,
        budgetTurns: o.budgetTurns,
        // The budget's kill goes through `killProcessTree`, which only reaches
        // the child's tool tree when the child leads its own group.
        processGroup: true,
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
  };
}
