/**
 * lean/challenge — one adversary round after build, against the current head.
 *
 * `specify` proves a spec is falsifiable before anybody codes. `challenge` asks
 * the sharper question afterwards: the builder says it is done, the frozen tests
 * pass, and is there a case the frozen tests never thought of that still fails?
 * A round that finds one has bought the run a second build against a real gap;
 * a round that finds nothing has cost one dispatch and confirmed nothing was
 * found by an adversary paid to look. That asymmetry is why `none` is a VERDICT
 * and not an error — and why the step commits nothing in that case: there is
 * nothing that was proved to fail.
 *
 * The machinery is `specify`'s, unchanged: validate the submitted rows at the
 * boundary, CAPTURE the bytes through one descriptor each, RESET the tree to the
 * commit the proof runs against, REWRITE, prove each file red, COMMIT with a
 * pathspec and hash the committed blobs. It lives in `specify-run.ts` for both
 * steps. The one thing `challenge` passes differently is the ref: `specify`
 * resets to the run's base sha (its claim is red-on-nothing), `challenge` resets
 * to the current head (its claim is red-on-the-code-that-claims-to-be-done).
 *
 * The differences that ARE challenge's own:
 *
 *   1. **Preconditions before the dispatch** — the frozen map is non-empty and
 *      every frozen blob still hashes to its record AT THE HEAD (build's
 *      `assertFrozenIntact`, the same claim build refuses to build without), the
 *      worktree is this run's and sits at that head, and the runner template
 *      exists. A child is never paid to work in a tree the step cannot account
 *      for, and never paid to attack an implementation whose tests were edited.
 *   2. **The adversary may not replace a frozen test.** It is shown the frozen
 *      paths and asked for NEW files, and a submission naming a frozen path is
 *      refused at the boundary (`frozenPaths` into `validateSubmitRows`) — the
 *      child is not trusted to obey its own prompt about the one file that would
 *      rewrite the contract.
 *   3. **The red proof is the round's verdict.** Green or unclear means the
 *      builder already handles that case, so the file is dropped; infra throws.
 *      Nothing survives the proof and nothing is committed ⇒ `none`.
 *
 * `frozenFromLog` unions a `challenge:new-tests` map into what build and verify
 * hold, so the new tests join the contract rather than sitting beside it.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { execp } from "../exec.ts";
import { spawnSpecialist } from "../spawn.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchSpec } from "../types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { headSha } from "./build-git.ts";
import { assertFrozenIntact } from "./build-normalise.ts";
import { frozenFromLog, testsFromLog } from "./build.ts";
import { ChallengeInfraError, dispatchAdversary } from "./challenge-dispatch.ts";
import type { ChallengeDispatch, ChallengeExec } from "./challenge-types.ts";
import { leanChildOpts } from "./child-opts.ts";
import { type TestLocation, testLocationOf } from "./config-test-location.ts";
import type { WorkConfig } from "./config.ts";
import { loadWorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { type PiSpec, parsePiSpec, readiness } from "./spec.ts";
import { existsInCommit, fileProblem } from "./specify-path.ts";
import { testCriteria } from "./specify-prompt.ts";
import type { TestRunLimits } from "./specify-proof.ts";
import { SpecifyResetError, resetWorktreeToBase } from "./specify-reset.ts";
import { SpecifyInfraError, runTestPipeline } from "./specify-run.ts";
import {
  assertSpecifyWorktreeOwned,
  ensureSpecifyWorktreeWithProvision,
  specifyBranch,
  specifyWorktreePath,
  validateSubmitRows,
} from "./specify-tree.ts";
import type { Outcome } from "./state.ts";
import {
  type BudgetArms,
  type BudgetOpts,
  type BudgetStop,
  type DispatchUsageRow,
  armBudget,
  budgetFor,
  budgetVerdictWithRows,
  readDispatched,
} from "./step-budget.ts";
import { extractSubmitTests } from "./submit-tests-extract.ts";

export interface ChallengeDeps {
  exec: ChallengeExec;
  dispatch: ChallengeDispatch;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  /** Preflight for the reporter companion; `statReporterPath` in production. */
  statReporter?: (p: string) => Promise<unknown>;
  /** Per-run runner limits; a test injects a short timeout to prove a hang is infra. */
  testLimits?: TestRunLimits;
}

/**
 * What `headSha` must return before any of it may be used: a git commit id.
 * Everything downstream — `rev-parse HEAD^`, `diff <sha> <sha>`, `show <sha>:<p>`
 * — reinterprets a value that is not one as a REF, so `"main"` or a ref name
 * coming back from `rev-parse` would silently retarget the whole round at a
 * different commit instead of failing.
 */
const COMMIT_ID = /^[0-9a-f]{40}$/;

/** The spec, re-read from the forge — the same contract the builder worked to. */
async function specOf(deps: ChallengeDeps, repoRoot: string, issue: number): Promise<PiSpec> {
  let body: string;
  try {
    body = await deps.fetchIssueBody(repoRoot, issue);
  } catch (err) {
    throw new ChallengeInfraError(`could not read the issue: ${(err as Error).message}`);
  }
  const parsed = parsePiSpec(body);
  if (!parsed.ok) throw new ChallengeInfraError(`the issue's spec is unusable: ${parsed.reason}`);
  // The SAME readiness judgement `specify` gates the run on, applied on re-read.
  // The issue is editable while the run is going, so a spec that was ready at
  // `ready` need not be ready now — and the round's whole claim is stated
  // against these criteria. One that is no longer well-formed cannot be
  // adjudicated, so it is infrastructure, not a verdict.
  const rules = readiness(parsed.spec);
  if (rules.length > 0)
    throw new ChallengeInfraError(`the issue's spec is not ready: ${rules.join("; ")}`);
  return parsed.spec;
}

/**
 * The tree, the head, and the two claims that must hold before a child is paid:
 * this worktree is ours at THIS commit, and the frozen contract still matches it.
 *
 * Both are the checks `build` makes for exactly the same reason, from the same
 * functions: an adversary is expensive and proves neither, and paying one to
 * attack an implementation whose tests were quietly edited would produce a round
 * that reports `none` — a certification, from a tree nobody verified.
 *
 * `frozen` is passed IN rather than read here: the map is the step log's, and a
 * precondition that re-derived it would be a second reader of the record.
 */
async function assertTreeAndContract(
  deps: ChallengeDeps,
  opts: {
    repoRoot: string;
    wt: string;
    branch: string;
    base: string;
    frozen: Record<string, string>;
  },
): Promise<string> {
  const { repoRoot, wt, branch, base, frozen } = opts;
  if (!existsSync(wt)) throw new ChallengeInfraError(`the worktree ${wt} does not exist`);
  try {
    assertSafeRef(branch);
    if (base.trim() !== "") assertSafeRef(base);
  } catch (err) {
    throw new ChallengeInfraError((err as Error).message);
  }
  const headBefore = await headSha(deps.exec, wt);
  // Validate BEFORE the value reaches anything: it is the ref this step resets
  // to, proves red against, and makes its commit on top of.
  if (!COMMIT_ID.test(headBefore))
    throw new ChallengeInfraError(
      `HEAD is not a commit id: ${JSON.stringify(headBefore)} in ${wt}`,
    );
  try {
    // `headMustBe = headBefore`: registered, on the run's branch, sitting at the
    // head the frozen records were hashed at. Build passes the same pair for the
    // same reason — a tree at any other commit is not this run's to write into.
    await assertSpecifyWorktreeOwned(deps.exec, {
      repoRoot,
      wt,
      baseSha: base,
      branch,
      headMustBe: headBefore,
    });
    // Non-empty and still hashing to its records at the head: the identical
    // claim build refuses to build on, from the identical function.
    await assertFrozenIntact(deps.exec, wt, headBefore, frozen);
  } catch (err) {
    throw new ChallengeInfraError((err as Error).message);
  }
  return headBefore;
}

/** The `challenge` step. Returns `new-tests` | `none`; THROWS on infrastructure. */
export async function challengeOutcome(ctx: HandlerCtx, deps: ChallengeDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;

  // 1. The contract the run already holds, read out of its own record — the
  //    union of every `specify:ok` and `challenge:new-tests` the log carries, so
  //    a resumed run attacks the same tests a live one was shown.
  const frozen = frozenFromLog(ctx.steps);
  // The same record, read per criterion: the file quota is a RUN-level bound, so
  // what an earlier round already froze for a criterion counts against it and a
  // second challenge round cannot double the cap by being a second call. A
  // resumed run seeds from what a crashed one froze, exactly as `frozen` above
  // does. Union of `specify:ok` and `challenge:new-tests`, same log reader.
  const frozenByCriterion = testsFromLog(ctx.steps);
  const branch = specifyBranch(ctx.run.branch, issue);
  const wt = specifyWorktreePath(repoRoot, issue);
  const base = ctx.run.baseSha;
  // Everything below — ownership, the frozen check, the reset and the red proof
  // — is stated against the CURRENT head, not the base: the base no longer has
  // the implementation, and a test that is red there proves nothing about code
  // that does not exist there.
  const headBefore = await assertTreeAndContract(deps, {
    repoRoot,
    wt,
    branch,
    base,
    frozen,
  });

  // 2. The config and the runner, BEFORE the child is paid: without a template
  //    every submitted file proves nothing, so the round could only ever report
  //    `none` — which is not a verdict about the code, it is a missing setting.
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new ChallengeInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const spec = await specOf(deps, repoRoot, issue);
  const wanted = testCriteria(spec);
  // ONE binding, ONE refusal: `runnerTemplate` is the string the runner needs and
  // `testRunner` is the same string shown to the adversary, so there is exactly
  // one place that decides it is missing. A round whose files nobody executed
  // could only ever report `none`, which is not a verdict about the code — it is
  // a missing setting wearing one, so the refusal names the setting.
  const runnerTemplate: string | undefined = config.verify.test;
  const testLocation: TestLocation | undefined = testLocationOf(config.verify);
  if (runnerTemplate === undefined)
    throw new ChallengeInfraError(
      "no test runner configured (.pi/work.json verify.test) for a spec with test criteria",
    );

  // 3. The adversary, under the state's budget (#1883).
  const budget = armBudget(budgetFor(config, "challenge"));
  if (budget.warning !== undefined)
    traceWarn(`lean challenge #${String(issue)}: ${budget.warning}`);
  // The adversary's cost row is kept whatever it did, including the throw
  // (see the same comment in `build.ts`).
  let dispatched: [DispatchResult | BudgetStop, DispatchUsageRow];
  try {
    dispatched = await dispatchAdversary(deps.dispatch, {
      issue,
      spec,
      frozenPaths: Object.keys(frozen),
      wt,
      repoRoot,
      testRunner: runnerTemplate,
      budget,
      ...(testLocation === undefined ? {} : { testLocation }),
      ...(deps.statReporter === undefined ? {} : { statReporter: deps.statReporter }),
    });
  } catch (err) {
    if (err instanceof ChallengeInfraError)
      throw new ChallengeInfraError(err.message, err.dispatches ?? []);
    throw err;
  }
  const [adversary, row] = dispatched;
  const rows = [row];
  const read = readDispatched(adversary);
  if ("stop" in read) {
    // A killed child leaves whatever it wrote behind, and nothing else resets the
    // tree before `verify`, which refuses a dirty one. So the stop resets to the
    // head this step found, through the pipeline's own reset and clean-tree proof.
    // The reset's `clean -fdx` also takes the dependency links, so the tree is
    // provisioned again after it, the same order `build` uses.
    try {
      await resetWorktreeToBase(deps.exec, wt, headBefore, branch);
    } catch (err) {
      if (err instanceof SpecifyResetError)
        throw new ChallengeInfraError(
          `could not reset the challenge worktree to ${headBefore} after the budget stop: ${err.message}`,
        );
      throw new ChallengeInfraError(`unexpected reset failure: ${String(err)}`);
    }
    try {
      await provisionWorktree(deps.exec, repoRoot, wt);
    } catch (err) {
      throw new ChallengeInfraError(
        `could not re-provision the challenge worktree after the budget stop: ${(err as Error).message}`,
      );
    }
    return budgetVerdictWithRows("challenge", read.stop, rows);
  }
  const toolUses = read.result.toolUses ?? [];

  // 4-8. Validate, capture, reset to the HEAD, rewrite, prove red, commit.
  const pipeline = await runTestPipeline(
    {
      exec: deps.exec,
      wt,
      repoRoot,
      issue,
      branch,
      headBefore,
      runnerTemplate,
      // The round's claim is ONE red edge case, not a red for every criterion:
      // a finding for AC1 is worth freezing even when AC2 has none. `specify`
      // passes `"all-criteria"` and keeps its refusal; this step must not.
      coverage: "any-red",
      wanted: wanted.map((c) => c.id),
      extract: extractSubmitTests,
      validate: (rows) =>
        validateSubmitRows(rows, {
          spec,
          exists: (rel) => existsSync(path.join(wt, rel)),
          fileProblem: (rel) => fileProblem(wt, rel),
          // The refusal that keeps the adversary out of the contract: a path the
          // run already froze is not its to replace, whatever the prompt said.
          // Checked on the NORMALISED path, so `./tests//AC1-retry.test.sh`
          // cannot slip past as a name the set does not contain.
          frozenPaths: new Set(Object.keys(frozen)),
          // The same newness rule as `specify`, judged against the same BASE:
          // an edge case the adversary did not write is not an edge case, and
          // the base is where a file that predates the run can be seen for
          // what it is. At the head every test of the run is present, so the
          // head cannot answer this question.
          existsAtBase: (rel) => existsInCommit(deps.exec, repoRoot, base, rel),
          // Same size/quota rules as `specify`: an edge case of 1,000 lines is
          // not an edge case, and one criterion does not get four files ACROSS
          // THE RUN — hence the seed, so files the run already froze fill the
          // quota rather than a fresh call of two more per round.
          wt,
          frozenByCriterion,
          ...(testLocation === undefined ? {} : { testLocation }),
        }),
      // Provisioning is `challenge`'s own call, and the `prepare` the pipeline
      // re-runs after its reset is the same one: one code path builds the
      // dependency links a clean just removed, whether the tree was made here or
      // survived a crash.
      prepare: () =>
        ensureSpecifyWorktreeWithProvision(deps.exec, {
          repoRoot,
          issue,
          fromRef: headBefore,
          branch,
        }),
      commitMessage: `test: challenge tests for #${issue}`,
      ...(deps.testLimits === undefined ? {} : { testLimits: deps.testLimits }),
    },
    { toolUses },
  );

  if (pipeline.kind === "committed")
    return {
      kind: "new-tests",
      frozen: pipeline.frozen,
      tests: pipeline.tests,
      reason: pipeline.reason,
      dispatches: rows,
    };
  // Every pipeline kind is named here, deliberately: `uncovered` is unreachable
  // under `"any-red"` (that rule never returns it), and a `switch` that fell
  // through to `none` would let a future verdict kind the pipeline can return
  // be reported as "the adversary found nothing". Each kind gets its own line
  // so adding one is a type error here rather than a silent certification.
  if (pipeline.kind === "uncovered")
    throw new ChallengeInfraError(
      `the challenge pipeline reported an uncovered criterion, which its coverage rule cannot produce: ${pipeline.reason}`,
    );
  // Nothing was proved red against the head — either no file survived the
  // boundary, or every one of them the builder already handles. Both say the
  // same thing to the machine: the round found no gap, so the run goes to verify
  // with the contract it already had and nothing committed. NOT an error, and
  // the reason has to say so plainly enough for an operator to tell it apart
  // from a round that was never run.
  return { kind: "none", reason: pipeline.reason, dispatches: rows };
}

export { ChallengeInfraError } from "./challenge-dispatch.ts";

/** The infra errors the step's throws are instances of, re-exported for its tests. */
export { SpecifyInfraError };

/** The challenge step's dependencies: the outside world, injected. */
export function challengeDeps(headless: boolean): ChallengeDeps {
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
        // The budget's kill goes through `killProcessTree`, which only reaches
        // the child's tool tree when the child leads its own group.
        processGroup: true,
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
  };
}
