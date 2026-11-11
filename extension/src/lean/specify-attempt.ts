/**
 * lean/specify-attempt — one attempt of the `specify` step: one adversary
 * dispatch under the state's budget, then the shared test pipeline
 * (extract, validate, capture, reset to the base, rewrite, prove red, commit).
 *
 * `specify.ts` runs it once, and again on its one retry — with the previous
 * attempt's drop reasons, or with a fixed note when that attempt submitted
 * nothing at all. It returns the outcome the attempt reached, the drop labels
 * the boundary made, and whether the attempt was silent — no `submit_tests`
 * call it could read and nothing dropped — so the caller can decide whether a
 * retry is worth it; it never decides that itself. The pipeline itself is
 * shared with `challenge` through `specify-run.ts`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { statReporterPath } from "../reporter-preflight.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import { didNoWork } from "./build-dispatch.ts";
import type { TestLocation } from "./config-test-location.ts";
import type { WorkConfig } from "./config.ts";
import { throwIfDispatchFailed } from "./dispatch-verdict.ts";
import { type ProviderWaitClass, providerFaultOf } from "./provider-wait.ts";
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
  type DispatchUsageRow,
  armBudget,
  budgetFor,
  budgetStop,
  budgetVerdictWithRows,
  dispatchUsageRow,
  readDispatched,
} from "./step-budget.ts";
import { extractSubmitTests } from "./submit-tests-extract.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "./submit-tests-reporter.ts";

/**
 * The size refusals — the sentences in `test-size.ts` that say a file is too
 * long, too big, or not a text file. A drop carrying one of these is the one
 * the child can fix by making the file smaller, so it is the one whose detail
 * the operator's decline needs; a quota or location drop says a file should not
 * have been written at all, and stays attributed in the reason alone.
 */
const SIZE_REFUSAL =
  / lines; an acceptance test is at most | bytes; an acceptance test is at most | is not a text file/;

/** Everything one attempt needs, all of it decided by the caller before the first dispatch. */
interface SpecifyAttemptArgs {
  deps: SpecifyDeps;
  config: WorkConfig;
  repoRoot: string;
  issue: number;
  spec: PiSpec;
  /**
   * The issue body the step re-read before parsing `spec` — the SAME bytes,
   * never a second fetch. Shown to the adversary as the task statement; absent
   * renders no section (`lean/issue-prose.ts`).
   */
  issueBody?: string;
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
  /** See {@link SpecifyPromptOpts.resubmit}: retry with the fixed "you never
   * submitted" note instead of the drop reasons. */
  resubmit?: boolean;
}

interface SpecifyAttemptResult {
  outcome: Outcome;
  /** The attributed drop labels the boundary made in this attempt. */
  refused: string[];
  /**
   * Nothing reached the boundary at all: the child made no `submit_tests` call
   * the step could read, and no row it did declare was dropped there. Only the
   * no-candidate verdict can be silent; `ok`, `uncovered` and a budget stop all
   * report `false`.
   */
  silent: boolean;
  /**
   * What this attempt's dispatch cost, reported SEPARATELY from the outcome.
   *
   * The caller owns the retry, and the retry owns the step's single outcome —
   * so if the rows lived only on the outcome, a second attempt would overwrite
   * the first's and the run would report one child where it paid for two. The
   * caller folds these; an attempt's own outcome still carries its rows, so a
   * reader of the log alone sees the same truth as the fold.
   */
  dispatched: DispatchUsageRow[];
  /**
   * The endpoint killed this child BEFORE it did any work and the taxonomy calls
   * that fault transient, so the caller may wait it out and re-prompt. Only on
   * positive `didNoWork` evidence; every other dead child still throws.
   */
  providerFault?: ProviderWaitClass;
}

/** A dead specify child the caller may re-prompt, discriminated by field presence. */
interface NoWorkProviderFault {
  readonly providerFault: ProviderWaitClass;
  readonly row: DispatchUsageRow;
}

/**
 * The dispatch, with a non-OK child turned into the throw it deserves — except a
 * child the ENDPOINT killed before it did any work, which is a retry the run
 * already owns and comes back as a row carrying the classification.
 *
 * The row this dispatch cost comes back on every path that RECEIVED a
 * `DispatchResult`: the ok path, the budget stop, the retryable provider fault,
 * and the `SpecifyInfraError` (which carries it on the error, because a throw
 * records no outcome and the child still spent tokens).
 */
async function dispatchAdversary(
  deps: SpecifyDeps,
  opts: {
    issue: number;
    spec: PiSpec;
    /** See {@link SpecifyAttemptArgs.issueBody} — the same bytes, not a re-fetch. */
    issueBody?: string;
    wt: string;
    repoRoot: string;
    testRunner?: string;
    testLocation?: TestLocation;
    budget: BudgetArms;
    /** The drop reasons of the previous attempt; set only on the one retry. */
    refusal?: string[];
    /** See {@link SpecifyAttemptArgs.resubmit}. */
    resubmit?: boolean;
  },
): Promise<[DispatchResult | BudgetStop | NoWorkProviderFault, DispatchUsageRow]> {
  await (deps.statReporter ?? statReporterPath)(SUBMIT_TESTS_REPORTER_PATH);
  const prompt = specifyPrompt({
    issue: opts.issue,
    spec: opts.spec,
    ...(opts.issueBody === undefined ? {} : { issueBody: opts.issueBody }),
    testRunner: opts.testRunner,
    ...(opts.testLocation === undefined ? {} : { testLocation: opts.testLocation }),
    worktree: opts.wt,
    ...(opts.refusal === undefined ? {} : { refusal: opts.refusal }),
    ...(opts.resubmit === true ? { resubmit: true } : {}),
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
  const row = dispatchUsageRow(result);
  // BEFORE the infra throw: the step's own ceiling ending the child is a
  // verdict about the round, not a fault in the harness.
  const fired = opts.budget.fired(result);
  if (fired !== undefined) return [budgetStop(fired), row];
  // An endpoint-killed child that did nothing is a re-prompt, not a handed-back
  // run; the shared ladder decides which deaths qualify.
  if (
    (result.ok === false || result.killCause !== undefined || result.errorStop !== undefined) &&
    didNoWork(result)
  ) {
    const cls = providerFaultOf(result);
    if (cls !== undefined) return [{ providerFault: cls, row }, row];
  }
  throwIfDispatchFailed(result, SpecifyInfraError, "specify dispatch failed: ", [row]);
  return [result, row];
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
 * owes — `specify` has required all of them, so the pipeline's partial-red case
 * is a refusal here, not a partial freeze.
 *
 * Returns the boundary's drop reasons and whether the attempt submitted nothing
 * at all: those are the two refusals the caller retries on.
 *
 * THROWS on infrastructure (a dispatch that died, a pipeline fault).
 */
export async function runSpecifyAttempt(args: SpecifyAttemptArgs): Promise<SpecifyAttemptResult> {
  const { deps, config, repoRoot, issue, spec, wt, base, branch, runnerTemplate } = args;
  const { testLocation, wanted, frozenByCriterion, refusal, resubmit } = args;
  const observeVerdict = deps.observeVerdict;
  // The body the step already fetched to parse `spec` — threaded, never re-read.
  const { issueBody } = args;
  // Each dispatch gets its own budget, armed the way the first was.
  const budget = armBudget(budgetFor(config, "specify"));
  if (budget.warning !== undefined) traceWarn(`lean specify #${String(issue)}: ${budget.warning}`);
  const dispatched = await dispatchAdversary(deps, {
    issue,
    spec,
    ...(issueBody === undefined ? {} : { issueBody }),
    wt,
    repoRoot,
    testRunner: runnerTemplate,
    budget,
    ...(refusal === undefined ? {} : { refusal }),
    ...(resubmit === true ? { resubmit: true } : {}),
    ...(testLocation === undefined ? {} : { testLocation }),
  });
  const [dispatchedChild, row] = dispatched;
  // Every outcome this attempt returns carries the row: a dispatch that ended
  // the attempt is still a dispatch the run paid for.
  const rows = [row];
  // The provider-faulted child never reaches the pipeline below: it left nothing
  // to capture, validate, or prove red. The caller waits the fault out and re-prompts.
  if ("providerFault" in dispatchedChild)
    return {
      outcome: {
        kind: "no-red-test",
        failedRules: ["the provider faulted before the child did any work"],
        reason: "the provider faulted before the child did any work",
        dispatches: rows,
      },
      refused: [],
      silent: false,
      dispatched: rows,
      providerFault: dispatchedChild.providerFault,
    };
  const dispatchedRead = readDispatched(dispatchedChild);
  if ("stop" in dispatchedRead)
    return {
      outcome: budgetVerdictWithRows("specify", dispatchedRead.stop, rows),
      refused: [],
      silent: false,
      dispatched: rows,
    };
  const toolUses = dispatchedRead.result.toolUses ?? [];
  const refused: string[] = [];
  // Read once: what this attempt's child declared, and how many of its calls
  // were unreadable. Both feed the silence test below and the pipeline above.
  const { rows: declaredRows, skipped } = extractSubmitTests(toolUses);
  /** The attributed drops whose reason is a size refusal — see `SIZE_REFUSAL`. */
  const sizeRefused: string[] = [];
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
      // uncovered criterion refuses the run — what `coverage: "all-criteria"`
      // asks the shared pipeline for, where `challenge` wants a partial freeze.
      coverage: "all-criteria",
      wanted: wanted.map((c) => c.id),
      extract: () => ({ rows: declaredRows, skipped }),
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
          // The quota is a RUN-level bound: on a re-run of the step (a resumed
          // cycle whose log already carries a decided `specify:ok`) it is what
          // stops a second round refilling every criterion to two files.
          frozenByCriterion,
          ...(testLocation === undefined ? {} : { testLocation }),
        });
        refused.push(...verdict.dropped.map(droppedLabel));
        sizeRefused.push(
          ...verdict.dropped.filter((d) => SIZE_REFUSAL.test(d.reason)).map(droppedLabel),
        );
        return verdict;
      },
      prepare: () =>
        ensureSpecifyWorktreeWithProvision(deps.exec, {
          repoRoot,
          issue,
          fromRef: base,
          branch,
          // The pipeline resets to the base before calling this prepare.
          allowAheadOfBase: true,
          ...(deps.beforeSubmoduleInit === undefined
            ? {}
            : { beforeSubmoduleInit: deps.beforeSubmoduleInit }),
        }),
      commitMessage: `test: acceptance tests for #${issue}`,
      ...(config.verify.freezeCheck === undefined
        ? {}
        : { freezeCheck: config.verify.freezeCheck }),
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
        dispatches: rows,
      },
      refused,
      silent: false,
      dispatched: rows,
    };
  if (pipeline.kind === "uncovered")
    return {
      outcome: {
        kind: "no-red-test",
        failedRules: pipeline.uncovered,
        reason: pipeline.reason,
        dispatches: rows,
      },
      refused,
      silent: false,
      dispatched: rows,
    };
  // No kept candidate at all, and there are TWO reasons for that, which the
  // operator needs told apart: a child that never called `submit_tests` at all
  // (nothing reached the boundary — the adversary's turn ended, the environment
  // is fine), and a child that submitted files which nothing proved red. The
  // bench showed the first reported as the second, which sent both to the same
  // `criterion ACn has no red test` and blamed the issue for a child that wrote
  // tests it never declared.
  //
  // The never-submitted rule keeps the SAME invariant as the gap rule it
  // replaces: the cause is the FIRST clause of every rule it appears in, so a
  // caller that renders only `failedRules`, or only the first 200 characters of
  // one, still reads WHY — and the drop notes the pipeline assembled follow it,
  // never lead. The size drops still ride as their own rules: a decline that only
  // ever says the generic line leaves the operator to work out that the child
  // wrote 154 lines against a cap of 150.
  const silent = declaredRows.length === 0 && skipped === 0 && refused.length === 0;
  // The verdict's two gating values, reported before either is folded into the
  // outcome — see `SpecifyDeps.observeVerdict`.
  observeVerdict?.({ refused: [...refused], silent });
  const generic = silent
    ? ["the child never submitted a test: it ended without calling submit_tests"]
    : wanted.map((c) => `criterion ${c.id} has no red test`);
  const rules = [...generic, ...sizeRefused];
  return {
    outcome: {
      kind: "no-red-test",
      failedRules: rules,
      // `reason` opens with the GENERIC rules only, then the pipeline's own
      // drop notes: `rules` is what `failedRules` carries, and a reason that
      // repeated every size drop the notes already spell would say it twice.
      reason: [generic.join("; "), pipeline.reason].filter((s) => s !== "").join("; "),
      dispatches: rows,
    },
    refused,
    // Silence is one specific state — computed above, from the same predicate —
    // and it is the only state this rule names: the child made no `submit_tests`
    // call the step could read (no row, no malformed call) and the boundary
    // dropped none of its rows. A child whose calls were all malformed, or whose
    // rows the boundary dropped, has something the retry can already name, so its
    // prompt quotes those reasons rather than this nudge. A file the RED PROOF
    // refused is not counted here: the proof judges bytes the step already holds,
    // so being asked to submit again could not change its verdict, and the
    // refusal retry already prints what it found.
    silent,
    dispatched: rows,
  };
}
