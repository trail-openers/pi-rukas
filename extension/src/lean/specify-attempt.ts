/**
 * lean/specify-attempt — one attempt of the `specify` step: one adversary dispatch under the
 * state's budget, then the shared test pipeline (extract, validate, capture, reset, rewrite, prove,
 * commit).
 *
 * `specify.ts` runs it once, and again on its one retry — with the previous attempt's drop reasons, or
 * with a fixed note when it submitted nothing at all. It returns the outcome, the boundary's drop labels,
 * and whether the attempt was silent, so the caller decides whether a retry is worth it. A child that
 * submitted only some test criteria is re-asked for the rest inside the attempt (`specify-reask.ts`).
 * The pipeline is shared with `challenge` through `specify-run.ts`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { allPreserved, malformedDeclarations } from "../lean-preserved-coverage.ts";
import { droppedLabel } from "../lean-preserved-notes.ts";
import { preservedCriteria } from "../lean-preserved-step.ts";
import { verdictReasonClause } from "../lean-step-bound.ts";
import { statReporterPath } from "../reporter-preflight.ts";
import { makeRunId } from "../spawn-support.ts";
import { allPreservedReason } from "../specify-preserves.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import { didNoWork } from "./build-dispatch.ts";
import type { TestLocation } from "./config-test-location.ts";
import type { WorkConfig } from "./config.ts";
import { throwIfDispatchFailed } from "./dispatch-verdict.ts";
import { type ProviderWaitClass, providerFaultOf } from "./provider-wait.ts";
import { leanRunnerPreflightEnabled } from "./runner-preflight-switch.ts";
import type { Criterion, PiSpec } from "./spec.ts";
import { RED_TEST_GAP, leanSpecifyGapHandbackEnabled } from "./specify-gap-switch.ts";
import { existsInCommit, fileProblem } from "./specify-path.ts";
import { specifyPrompt } from "./specify-prompt.ts";
import {
  adversaryDispatchOpts,
  leanSpecifyReaskEnabled,
  missingCriteria,
  reaskMissing,
  withReaskNote,
} from "./specify-reask.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import { runTestPipeline } from "./specify-run.ts";
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
 * The size refusals — the sentences in `test-size.ts` that say a file is too long, too big, or not a
 * text file. A drop carrying one is the one the child can fix by making the file smaller, so it is the
 * one whose detail the operator's decline needs.
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
   * The issue body the step re-read before parsing `spec` — the SAME bytes, never a second fetch.
   * Absent renders no section (`lean/issue-prose.ts`).
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
  /** #2644 — the hung-request lever the caller derived from the run's deadline. */
  stall?: Parameters<typeof armBudget>[1];
  /** The child bound the caller derived from the run's deadline at this dispatch; it rides beside
   *  the lever, both from one `stepDispatchArms`. */
  bound?: Parameters<typeof armBudget>[2];
}

interface SpecifyAttemptResult {
  outcome: Outcome;
  /** The attributed drop labels the boundary made in this attempt. */
  refused: string[];
  /**
   * Nothing reached the boundary at all: no `submit_tests` call the step could read, and no declared
   * row dropped there. Only the no-candidate verdict can be silent.
   */
  silent: boolean;
  /**
   * What this attempt's dispatch cost, reported SEPARATELY from the outcome.
   *
   * The caller owns the retry, and the retry owns the step's single outcome — rows that lived only on
   * the outcome would let a second attempt overwrite the first's. The outcome still carries its own
   * rows, so a reader of the log alone sees the same truth as the fold.
   */
  dispatched: DispatchUsageRow[];
  /**
   * The endpoint killed this child BEFORE it did any work and the taxonomy calls that fault transient,
   * so the caller may wait it out and re-prompt. Only on positive `didNoWork` evidence.
   */
  providerFault?: ProviderWaitClass;
}

/** A dead specify child the caller may re-prompt, discriminated by field presence. */
interface NoWorkProviderFault {
  readonly providerFault: ProviderWaitClass;
  readonly row: DispatchUsageRow;
}

/**
 * The dispatch, with a non-OK child turned into the throw it deserves — except a child the ENDPOINT
 * killed before it did any work, which comes back as a row carrying the classification.
 *
 * The row this dispatch cost comes back on every path that RECEIVED a `DispatchResult`, including the
 * `SpecifyInfraError` — a throw records no outcome and the child still spent tokens.
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
    /** The child's session id, minted only when its re-ask is switched on. */
    runId?: string;
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
    adversaryDispatchOpts(opts),
  );
  const row = dispatchUsageRow(result);
  // BEFORE the infra throw: the step's own ceiling ending the child is a verdict about the round.
  const fired = opts.budget.fired(result);
  if (fired !== undefined) return [budgetStop(fired), row];
  // An endpoint-killed child that did nothing is a re-prompt, not a handed-back run.
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
 * Dispatch, extract, validate, CAPTURE, RESET to the base, REWRITE, prove every kept file red ON THE
 * BASE, and commit — once.
 *
 * The ref is the base: `specify`'s claim is that it froze the tests ON the base, so the child's work is
 * undone back to the commit `ready` resolved. A coverage gap is `red-test-gap` (`no-red-test` with the
 * gap switch off), and there is no third verdict: the pipeline's partial-red case is a refusal here, not
 * a partial freeze.
 *
 * Returns the boundary's drop reasons and whether the attempt submitted nothing at all — the two
 * refusals the caller retries on. THROWS on infrastructure.
 */
export async function runSpecifyAttempt(args: SpecifyAttemptArgs): Promise<SpecifyAttemptResult> {
  const { deps, config, repoRoot, issue, spec, wt, base, branch, runnerTemplate } = args;
  const { testLocation, wanted, frozenByCriterion, refusal, resubmit } = args;
  const observeVerdict = deps.observeVerdict;
  // The body the step already fetched to parse `spec` — threaded, never re-read.
  const { issueBody } = args;
  // Each dispatch gets its own budget, armed the way the first was.
  const budget = armBudget(budgetFor(config, "specify"), args.stall, args.bound);
  if (budget.warning !== undefined) traceWarn(`lean specify #${String(issue)}: ${budget.warning}`);
  // Minted here, before the child exists, so its re-ask can open the same session. A retry attempt
  // gets none: the step's ceiling is one child, one follow-up and one fresh retry.
  const runId =
    leanSpecifyReaskEnabled() && refusal === undefined && resubmit !== true
      ? makeRunId()
      : undefined;
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
    ...(runId === undefined ? {} : { runId }),
  });
  const [dispatchedChild, row] = dispatched;
  // Every outcome this attempt returns carries the row: a dispatch that ended
  // the attempt is still a dispatch the run paid for.
  const rows = [row];
  // The provider-faulted child left nothing to capture, validate, or prove red; the caller waits it out.
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
      outcome: verdictReasonClause(
        budgetVerdictWithRows("specify", dispatchedRead.stop, rows),
        args.bound,
      ),
      refused: [],
      silent: false,
      dispatched: rows,
    };
  const toolUses = dispatchedRead.result.toolUses ?? [];
  const refused: string[] = [];
  // Read once: what the child declared, and how many calls were unreadable.
  const first = extractSubmitTests(toolUses);
  /** The boundary every declared row passes, read against the child's tree and the run's base. */
  const boundary = {
    spec,
    exists: (rel: string) => existsSync(path.join(wt, rel)),
    fileProblem: (rel: string) => fileProblem(wt, rel),
    // A test the child did not write is not an acceptance test: an existing tracked project test
    // freezes as "red" without ever being run, and a child that overwrote one rewrites the
    // contract. Both are refused against the run's BASE.
    existsAtBase: (rel: string) => existsInCommit(deps.exec, repoRoot, base, rel),
    // The size/quota rules judge the file with the same code the capture
    // reads it with; `wt` is the tree these paths are relative to.
    wt,
    // The quota is a RUN-level bound: on a re-run of the step it is what stops a second round
    // refilling every criterion to two files.
    frozenByCriterion,
    ...(testLocation === undefined ? {} : { testLocation }),
  };
  // Before readiness is judged, a child that declared some test criteria and not others is asked once
  // for the rest, while its files are still in the tree (`specify-reask.ts`).
  const reask = await reaskMissing({
    skipped: first.skipped,
    refuses: async () => (await validateSubmitRows(first.rows, boundary)).dropped.length > 0,
    dispatch: deps.dispatch,
    first: dispatchedRead.result,
    runId,
    missing: missingCriteria(
      wanted.map((c) => c.id),
      first.rows,
    ),
    declared: first.rows.length,
    budget: budgetFor(config, "specify"),
    // The re-ask keeps the first child's bound, so the pair agrees on the room.
    bound: args.bound,
    wt,
    repoRoot,
    issue,
  });
  if (reask !== undefined) rows.push(reask.row);
  if (reask !== undefined && "stop" in reask)
    return {
      outcome: verdictReasonClause(budgetVerdictWithRows("specify", reask.stop, rows), args.bound),
      refused: [],
      silent: false,
      dispatched: rows,
    };
  const declaredRows = reask === undefined ? first.rows : [...first.rows, ...reask.rows];
  const wantedIds = wanted.map((c) => c.id);
  // A declaration of the wrong type is a malformed call, counted where the malformed calls are counted.
  const skipped = first.skipped + (reask?.skipped ?? 0) + malformedDeclarations(declaredRows);
  const preservedRows = preservedCriteria(declaredRows);
  const note = reask?.note;
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
      // `specify`'s claim is that EVERY test criterion is falsifiable, so one uncovered criterion
      // refuses the run — what `coverage: "all-criteria"` asks the shared pipeline for.
      coverage: "all-criteria",
      wanted: wantedIds,
      extract: () => ({ rows: declaredRows, skipped }),
      validate: async (rows) => {
        const verdict = await validateSubmitRows(rows, boundary);
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
      ...(config.verify.format === undefined ? {} : { formatTemplate: config.verify.format }),
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
      outcome: withReaskNote(
        {
          kind: "ok",
          frozen: pipeline.frozen,
          tests: pipeline.tests,
          // Absent, never empty: `preserved-record.ts` refuses an empty list. Read off what the pipeline
          // FROZE, not off the child's declarations: a `preserves: true` row that turned out to be an
          // ordinary red test froze no must-pass file, and the disclosure may not claim one.
          ...(pipeline.preserved.length === 0 ? {} : { preserved: pipeline.preserved }),
          reason: pipeline.reason,
          dispatches: rows,
        },
        note,
      ),
      refused,
      silent: false,
      dispatched: rows,
    };
  // The child's own gap — not a refused spec — so the switch picks its kind (see `specify-gap-switch.ts`).
  const gapKind = leanSpecifyGapHandbackEnabled() ? RED_TEST_GAP : "no-red-test";
  // A spec whose every test criterion is preserved has nothing to build: its own stable reason, never a
  // freeze of a contract made of guards alone.
  if (allPreserved(wantedIds, preservedRows))
    return {
      outcome: withReaskNote(
        {
          kind: gapKind,
          failedRules: wanted.map((c) => `criterion ${c.id} has no red test`),
          reason: allPreservedReason(preservedRows),
          // The record carries its own preserved list: the handback's second reading and its hint key on
          // this field, and this gap's reason is its own stable sentence that never quotes the red proof.
          // A gap that discloses its cause but not the move it implies is the half-disclosure this field
          // exists to close.
          ...(preservedRows.length === 0 ? {} : { preserved: preservedRows }),
          dispatches: rows,
        },
        note,
      ),
      refused,
      silent: false,
      dispatched: rows,
    };
  if (pipeline.kind === "uncovered")
    return {
      outcome: withReaskNote(
        {
          kind: gapKind,
          failedRules: pipeline.uncovered,
          reason: pipeline.reason,
          dispatches: rows,
        },
        note,
      ),
      refused,
      silent: false,
      dispatched: rows,
    };
  // No kept candidate at all, and there are TWO reasons the operator needs told apart: a child that
  // never called `submit_tests`, and a child that submitted files which nothing proved red.
  //
  // The never-submitted rule keeps the gap rule's invariant: the cause is the FIRST clause of every
  // rule it appears in, so a caller that renders only `failedRules` still reads WHY. The size drops
  // still ride as their own rules.
  const silent = declaredRows.length === 0 && skipped === 0 && refused.length === 0;
  // The verdict's two gating values, reported before either is folded into the
  // outcome — see `SpecifyDeps.observeVerdict`.
  observeVerdict?.({ refused: [...refused], silent });
  // The switch changes the WORDING of this one rule and nothing else: the silence predicate and the
  // single retry it gates both exist in the release the off arm restores.
  const generic =
    silent && leanRunnerPreflightEnabled()
      ? ["the child never submitted a test: it ended without calling submit_tests"]
      : wanted.map((c) => `criterion ${c.id} has no red test`);
  const rules = [...generic, ...sizeRefused];
  return {
    outcome: withReaskNote(
      {
        kind: gapKind,
        failedRules: rules,
        // `reason` opens with the GENERIC rules only: `rules` is what `failedRules` carries, and a
        // reason that repeated every size drop the notes already spell would say it twice.
        reason: [generic.join("; "), pipeline.reason].filter((s) => s !== "").join("; "),
        dispatches: rows,
      },
      note,
    ),
    refused,
    // Silence is one specific state — computed above, from the same predicate — and the only state
    // this rule names. A child whose calls were all malformed, or whose rows the boundary dropped, has
    // reasons the retry can already name. A file the RED PROOF refused is not counted here: being asked
    // to submit again could not change that verdict.
    silent,
    dispatched: rows,
  };
}
