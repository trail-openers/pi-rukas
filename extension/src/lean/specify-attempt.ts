/**
 * lean/specify-attempt — one attempt of the `specify` step: one adversary
 * dispatch under the state's budget (#1883), then the shared test pipeline
 * (extract, validate, capture, reset to the base, rewrite, prove red, commit).
 *
 * `specify.ts` runs it once, and again on its one retry with the previous
 * attempt's drop reasons in the prompt. It returns the outcome the attempt
 * reached and the drop labels the boundary made, so the caller can decide
 * whether a retry is worth it; it never decides that itself. The pipeline
 * itself is shared with `challenge` through `specify-run.ts`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { statReporterPath } from "../reporter-preflight.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import type { TestLocation } from "./config-test-location.ts";
import type { WorkConfig } from "./config.ts";
import type { Criterion, PiSpec } from "./spec.ts";
import { existsInCommit, fileProblem } from "./specify-path.ts";
import { specifyPrompt } from "./specify-prompt.ts";
import { SpecifyInfraError, droppedLabel, runTestPipeline } from "./specify-run.ts";
import { ensureSpecifyWorktreeWithProvision, validateSubmitRows } from "./specify-tree.ts";
import type { SpecifyDeps } from "./specify.ts";
import type { Outcome } from "./state.ts";
import {
  type BudgetArms,
  type BudgetStop,
  armBudget,
  budgetFor,
  budgetStop,
  budgetVerdict,
  readDispatched,
} from "./step-budget.ts";
import { extractSubmitTests } from "./submit-tests-extract.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "./submit-tests-reporter.ts";

/** Everything one attempt needs, all of it decided by the caller before the first dispatch. */
export interface SpecifyAttemptArgs {
  deps: SpecifyDeps;
  config: WorkConfig;
  repoRoot: string;
  issue: number;
  spec: PiSpec;
  /** The worktree the attempt writes in, and the base sha and branch it resets to. */
  wt: string;
  base: string;
  branch: string;
  runnerTemplate: string;
  testLocation?: TestLocation;
  wanted: Criterion[];
  /** The run's frozen test record, read once by the caller. */
  frozenByCriterion: Record<string, string[]>;
  /** The drop reasons of the previous attempt; set only on the retry. */
  refusal?: string[];
}

export interface SpecifyAttemptResult {
  outcome: Outcome;
  /** The attributed drop labels the boundary made in this attempt. */
  refused: string[];
}

/** The dispatch, with a non-OK child turned into the throw it deserves. */
async function dispatchAdversary(
  deps: SpecifyDeps,
  opts: {
    issue: number;
    spec: PiSpec;
    wt: string;
    repoRoot: string;
    testRunner?: string;
    testLocation?: TestLocation;
    budget: BudgetArms;
    /** The drop reasons of the previous attempt; set only on the one retry. */
    refusal?: string[];
  },
): Promise<DispatchResult | BudgetStop> {
  await (deps.statReporter ?? statReporterPath)(SUBMIT_TESTS_REPORTER_PATH);
  const prompt = specifyPrompt({
    issue: opts.issue,
    spec: opts.spec,
    testRunner: opts.testRunner,
    ...(opts.testLocation === undefined ? {} : { testLocation: opts.testLocation }),
    worktree: opts.wt,
    ...(opts.refusal === undefined ? {} : { refusal: opts.refusal }),
  });
  const result = await deps.dispatch(
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
      extraArgs: ["--no-skills", "--extension", SUBMIT_TESTS_REPORTER_PATH],
      ...opts.budget.opts,
    },
  );
  // BEFORE the infra throw: the step's own ceiling ending the child is a
  // verdict about the round, not a fault in the harness.
  const fired = opts.budget.fired(result);
  if (fired !== undefined) return budgetStop(fired);
  if (!result.ok || result.killCause !== undefined || result.errorStop !== undefined) {
    const why =
      result.killCause ??
      result.errorStop?.message ??
      result.errorStop?.reason ??
      `exit ${String(result.exitCode)}`;
    throw new SpecifyInfraError(`specify dispatch failed: ${String(why)}`);
  }
  return result;
}

/**
 * Dispatch, extract, validate, CAPTURE, RESET to the base, REWRITE, prove every
 * kept file red ON THE BASE, and commit — once.
 *
 * The ref is the base: `specify`'s claim is that it froze the tests ON the
 * base, so its `headBefore` IS the base and the child's work is undone back to
 * the commit `ready` resolved. The two verdicts the shared pipeline can return
 * are the two this step has always returned: a coverage gap is `no-red-test`,
 * and there is no third one. `uncovered` reports every criterion the run still
 * owes — `specify` has required all of them since before the split, so the
 * pipeline's partial-red case is a refusal here, not a partial freeze.
 *
 * Returns the boundary's drop reasons too: an attempt that dropped a row is the
 * only kind of refusal the child can fix by being told about it.
 *
 * THROWS on infrastructure (a dispatch that died, a pipeline fault).
 */
export async function runSpecifyAttempt(args: SpecifyAttemptArgs): Promise<SpecifyAttemptResult> {
  const { deps, config, repoRoot, issue, spec, wt, base, branch, runnerTemplate } = args;
  const { testLocation, wanted, frozenByCriterion, refusal } = args;
  // Each dispatch gets its own budget (#1883), armed the way the first was.
  const budget = armBudget(budgetFor(config, "specify"));
  if (budget.warning !== undefined) traceWarn(`lean specify #${String(issue)}: ${budget.warning}`);
  const dispatched = await dispatchAdversary(deps, {
    issue,
    spec,
    wt,
    repoRoot,
    testRunner: runnerTemplate,
    budget,
    ...(refusal === undefined ? {} : { refusal }),
    ...(testLocation === undefined ? {} : { testLocation }),
  });
  const dispatchedRead = readDispatched(dispatched);
  if ("stop" in dispatchedRead)
    return { outcome: budgetVerdict("specify", dispatchedRead.stop), refused: [] };
  const toolUses = dispatchedRead.result.toolUses ?? [];
  const refused: string[] = [];
  const pipeline = await runTestPipeline(
    {
      exec: deps.exec,
      wt,
      repoRoot,
      issue,
      branch,
      headBefore: base,
      runnerTemplate,
      // `specify`'s claim is that EVERY test criterion is falsifiable, so one
      // uncovered criterion refuses the run. The rule is passed explicitly now
      // that `challenge` shares this pipeline under `"any-red"` — a partial
      // freeze is what that step wants, and would be wrong here.
      coverage: "all-criteria",
      wanted: wanted.map((c) => c.id),
      extract: extractSubmitTests,
      validate: async (rows) => {
        const verdict = await validateSubmitRows(rows, {
          spec,
          exists: (rel) => existsSync(path.join(wt, rel)),
          fileProblem: (rel) => fileProblem(wt, rel),
          // A test the child did not write is not an acceptance test: an
          // existing tracked project test freezes as "red" without ever being
          // run, and a child that overwrote one rewrites the contract. Both are
          // refused against the run's BASE, which is the commit this step's
          // whole claim is made on.
          existsAtBase: (rel) => existsInCommit(deps.exec, repoRoot, base, rel),
          // The size/quota rules judge the file with the same code the capture
          // reads it with; `wt` is the tree these paths are relative to.
          wt,
          // The quota is a RUN-level bound. On a first `specify` the union is
          // empty and this changes nothing; on a re-run of the step (a resumed
          // or re-entered cycle whose log already carries a decided `specify:ok`)
          // it is what stops a second round refilling every criterion to two
          // files. Read from the same log `challenge` seeds its own quota with.
          frozenByCriterion,
          ...(testLocation === undefined ? {} : { testLocation }),
        });
        refused.push(...verdict.dropped.map(droppedLabel));
        return verdict;
      },
      prepare: () =>
        ensureSpecifyWorktreeWithProvision(deps.exec, { repoRoot, issue, fromRef: base, branch }),
      commitMessage: `test: acceptance tests for #${issue}`,
      ...(deps.capture === undefined ? {} : { capture: deps.capture }),
      ...(deps.testLimits === undefined ? {} : { testLimits: deps.testLimits }),
    },
    { toolUses },
  );
  if (pipeline.kind === "committed")
    return {
      outcome: {
        kind: "ok",
        frozen: pipeline.frozen,
        tests: pipeline.tests,
        reason: pipeline.reason,
      },
      refused,
    };
  if (pipeline.kind === "uncovered")
    return {
      outcome: { kind: "no-red-test", failedRules: pipeline.uncovered, reason: pipeline.reason },
      refused,
    };
  // No kept candidate at all. Every criterion is uncovered, which is the same
  // refusal this step returned before the split for the same cause — and, as
  // there, the reason LEADS with the rules rather than opening on the drop
  // notes, so the two fields a caller might render say the same thing first.
  const rules = wanted.map((c) => `criterion ${c.id} has no red test`);
  return {
    outcome: {
      kind: "no-red-test",
      failedRules: rules,
      reason: [rules.join("; "), pipeline.reason].filter((s) => s !== "").join("; "),
    },
    refused,
  };
}
