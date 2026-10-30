/**
 * lean/specify — the step that proves the acceptance tests are red before
 * anybody writes the implementation.
 *
 * The order is the design, and each stage exists because the one before it
 * cannot be trusted on its own:
 *
 *   1. re-read the spec from the forge — an issue body can change between
 *      `ready` and here, and a test frozen against a spec nobody re-read is
 *      frozen against a fiction;
 *   2. refuse the run on anything the step can settle WITHOUT an adversary: a
 *      spec with test criteria but no runner configured, an unhealthy base, and
 *      a directory at the worktree path the step does not own. An adversary is
 *      expensive and proves none of these;
 *   3. put a clean worktree at the run's base sha (create, or reset a leftover
 *      the step owns);
 *   4. dispatch ONE adversary that writes the tests and submits them;
 *   5. validate every submitted row at the boundary — criterion, path shape,
 *      existence, and that the path is an ordinary file of this worktree (not a
 *      symlink, not a hard link, not a path that resolves outside it);
 *   6. CAPTURE the bytes of every kept file into memory. That is the only thing
 *      that survives the child;
 *   7. RESET the worktree completely to the base — child commits, staged
 *      changes, untracked files and ignore tricks all go — and prove it;
 *   8. REWRITE the captured bytes to their paths, so what gets run, hashed and
 *      committed is exactly what was captured, whatever the child did next;
 *   9. prove red on exactly those bytes, per file, with the runner template.
 *      Every `verify: "test"` criterion must have at least one red file, or the
 *      step refuses the run;
 *  10. COMMIT the kept files and assert the commit contains exactly them; then
 *      HASH the committed blobs, so the record later steps check against
 *      describes the commit rather than a momentary state of the tree.
 *
 * The two kinds are deliberately apart. `no-red-test` is a VERDICT about the
 * work — the spec or the child's tests are not good enough, and the run ends
 * `not-ready` with named rules. A THROW is infrastructure — an unhealthy base, a
 * worktree the step does not own, a dispatch that died, a commit that did not
 * contain what it was told to — and the engine turns it into handed-back exit 10
 * without blaming the issue.
 *
 * The CAPTURE / RESET / REWRITE / PROVE / COMMIT pipeline is shared with
 * `challenge` through `specifyRun.ts`: `specify` calls it with the run's base
 * sha as the ref it resets to, and `challenge` with the current head. That is
 * the only difference between the two steps at this layer, so it is a parameter
 * rather than a second copy — see the module header there for what the ref
 * changes and what it must not.
 *
 * Everything outside the pure parts is injected, so the test drives a real
 * temp git repo through the same seams production uses.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { statReporterPath } from "../reporter-preflight.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchSpec } from "../types.ts";
import { guardCompilerIntegrity, packageDirFor } from "../work-driver-toolchain-canary.ts";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { testsFromLog } from "./build.ts";
import { type TestLocation, testLocationOf } from "./config-test-location.ts";
import type { WorkConfig } from "./config.ts";
import { loadWorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { type PiSpec, parsePiSpec, readiness } from "./spec.ts";
import type { CaptureResult } from "./specify-capture.ts";
import { existsInCommit, fileProblem } from "./specify-path.ts";
import { RED_PROOF_CONTRACT, namingLine, specifyPrompt, testCriteria } from "./specify-prompt.ts";
import type { TestRunLimits } from "./specify-proof.ts";
import { SpecifyResetError } from "./specify-reset.ts";
import { SpecifyInfraError, droppedLabel, runTestPipeline } from "./specify-run.ts";
import {
  assertSpecifyWorktreeOwned,
  declaredPaths,
  ensureSpecifyWorktreeWithProvision,
  specifyBranch,
  specifyWorktreePath,
  validateSubmitRows,
  worktreeExists,
} from "./specify-tree.ts";
import type { Outcome } from "./state.ts";
import {
  type BudgetArms,
  type BudgetOpts,
  type BudgetStop,
  armBudget,
  budgetFor,
  budgetStop,
  budgetVerdict,
  readDispatched,
} from "./step-budget.ts";
import { extractSubmitTests } from "./submit-tests-extract.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "./submit-tests-reporter.ts";

/** The dispatch seam: one child, one result. `spawnSpecialist` in production. */
export type SpecifyDispatch = (
  spec: DispatchSpec,
  opts: { writeFence?: WriteFence; extraArgs?: readonly string[] } & BudgetOpts,
) => Promise<DispatchResult>;

export interface SpecifyDeps {
  exec: ExecFn;
  dispatch: SpecifyDispatch;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
  /** The config for this run, loaded at the run's base sha. */
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  /** Preflight for the reporter companion; `statReporterPath` in production. */
  statReporter?: (p: string) => Promise<unknown>;
  /**
   * Reads the kept test files into memory; `captureTestBytes` in production.
   * A seam for the same reason every other filesystem fact here is one: the
   * smoke test proves the step commits the bytes it captured rather than
   * whatever the child leaves on disk afterwards, and that needs a read the
   * test can place against the child's own last write. The `owners` map tells
   * the capture which criterion claimed each path so a file it cannot read
   * through one descriptor drops as that criterion's row, not as an
   * unattributed line in the reason.
   */
  capture?: (wt: string, paths: string[], owners: Map<string, string>) => CaptureResult;
  /** Per-run runner limits; a test injects a short timeout to prove a hang is infra. */
  testLimits?: TestRunLimits;
}

/**
 * A base, a tree or a child we cannot trust. The engine turns this into 10.
 *
 * Re-exported from `specify-run.ts`, where the shared pipeline raises it, so
 * that module owns the throw without importing this step back: the class is
 * `instanceof`-tested by the specify and challenge smoke suites, and two copies
 * of it would make `err instanceof SpecifyInfraError` quietly false for whoever
 * imported the wrong one.
 */
export { SpecifyInfraError } from "./specify-run.ts"; /** The rules a spec fails on re-read, or [] when it still holds. */
function specRules(body: string): { spec?: PiSpec; rules: string[] } {
  const parsed = parsePiSpec(body);
  if (!parsed.ok) return { rules: [`spec: ${parsed.reason}`] };
  return { spec: parsed.spec, rules: readiness(parsed.spec) };
}

/**
 * Base health: the compiler canary (when the tier uses it), then the project's
 * fast verify tier. Both run BEFORE the adversary is dispatched.
 *
 * A red test is only evidence when the base builds, and a red is a VERDICT —
 * so the question "does the toolchain work at all" must be answered somewhere
 * that cannot be confounded with what a test prints. That place is here, and
 * it is the only place: a failure throws rather than dropping rows.
 *
 * The canary runs in the directory the tier runs the pinned compiler in
 * (`packageDirFor`, because the tier gets there with `cd extension && …`), and
 * the tier itself runs with the driver's knobs scrubbed, exactly as every
 * other verify child does. When provisioning could not give the tree its
 * dependencies, that is said in the message — a bare worktree failing a
 * dependency-hungry command is otherwise indistinguishable from a broken base.
 */
async function assertBaseHealthy(
  exec: ExecFn,
  wt: string,
  config: WorkConfig,
  provisioning?: { linked: string[]; problem?: string },
): Promise<void> {
  const fast = config.verify.fast;
  if (fast === undefined) return;
  const note =
    provisioning?.problem === undefined ? "" : ` — provisioning: ${provisioning.problem}`;
  const guard = await guardCompilerIntegrity({
    cmd: fast,
    cwd: packageDirFor(fast, wt),
    where: wt,
    run: exec,
  });
  if (guard?.failure !== undefined)
    throw new SpecifyInfraError(`base unhealthy: ${guard.failure}${note}`);
  // The shell form: a verify tier is a shell command line (`cd pkg && node
  // …/tsc --noEmit && bun run test`), not one executable plus argv, and it is
  // the project's own command that says whether this base builds at all.
  const ran = await exec(fast, {
    cwd: wt,
    timeout: 30 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: verifyChildEnv(),
  }).catch((err: unknown) => ({ __err: err }) as never);
  if ((ran as { __err?: unknown })?.__err !== undefined) {
    const e = (ran as { __err?: { stderr?: string; message?: string } }).__err;
    throw new SpecifyInfraError(
      `base unhealthy: verify.fast failed in ${wt}: ${(e?.stderr ?? e?.message ?? "unknown error")
        .replace(/\s+/g, " ")
        .slice(0, 400)}${note}`,
    );
  }
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
 * The worktree at the base — created, or reset to it — and provisioned. The
 * first attempt and the retry both come through here, so the tree the second
 * dispatch sees is cleaned exactly as the first one's was.
 */
async function prepareTree(
  deps: SpecifyDeps,
  opts: { repoRoot: string; issue: number; wt: string; base: string; branch: string },
): Promise<{ linked: string[]; problem?: string } | undefined> {
  try {
    const prepared = await ensureSpecifyWorktreeWithProvision(deps.exec, {
      repoRoot: opts.repoRoot,
      issue: opts.issue,
      fromRef: opts.base,
      branch: opts.branch,
    });
    return prepared.problem === undefined
      ? undefined
      : { linked: prepared.linked, problem: prepared.problem };
  } catch (err) {
    if (err instanceof SpecifyResetError) throw new SpecifyInfraError(err.message);
    throw new SpecifyInfraError(
      `could not prepare the worktree ${opts.wt}: ${(err as Error).message}`,
    );
  }
}

/** The note a retried attempt's outcome carries, so the operator can see the retry happened. */
const RETRY_NOTE = "(after one retry)";

/**
 * The second attempt's outcome with {@link RETRY_NOTE} on its reason. A budget
 * stop keeps its canonical sentence: that reason is the one the operator is
 * taught to read, and a retry suffix would bend it.
 */
function afterRetry(outcome: Outcome): Outcome {
  if (outcome.kind === "budget") return outcome;
  return {
    ...outcome,
    reason: outcome.reason === undefined ? RETRY_NOTE : `${outcome.reason} ${RETRY_NOTE}`,
  };
}

/** The `specify` step. Returns `ok` | `no-red-test` | `budget`; THROWS on infrastructure. */
export async function specifyOutcome(ctx: HandlerCtx, deps: SpecifyDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  // 1. The spec, re-read — `ready` may have run in another process, minutes
  //    or a crash ago, and the issue is the contract.
  let body: string;
  try {
    body = await deps.fetchIssueBody(repoRoot, issue);
  } catch (err) {
    throw new SpecifyInfraError(`could not read the issue: ${(err as Error).message}`);
  }
  const read = specRules(body);
  if (read.rules.length > 0) return { kind: "no-red-test", failedRules: read.rules };
  const spec = read.spec as PiSpec;

  const base = ctx.run.baseSha;
  if (base.trim() === "") throw new SpecifyInfraError("the run carries no base sha");
  const config = await deps.loadConfig(repoRoot, base);
  const testLocation = testLocationOf(config.verify);
  const branch = specifyBranch(ctx.run.branch, issue);
  const wt = specifyWorktreePath(repoRoot, issue);
  // A base sha and a branch name both reach git command lines in this step.
  // `assertSafeRef` is what stands between a ref and shell expansion.
  try {
    assertSafeRef(base);
    assertSafeRef(branch);
  } catch (err) {
    throw new SpecifyInfraError((err as Error).message);
  }

  const wanted = testCriteria(spec);
  // Narrowed HERE, at the refusal that proves it: one branch returns the
  // verdict when there are test criteria and no template, so past that point a
  // spec with test criteria has one. The call site below reads this narrowed
  // binding rather than re-casting the config field.
  const runnerTemplate =
    wanted.length > 0 && config.verify.test === undefined
      ? undefined
      : (config.verify.test as string);

  // 2. The preconditions, all of them BEFORE the dispatch. Each one is a fact
  //    the step can establish for itself, and an adversary spends tokens
  //    proving none of them: a run with no runner configured could only ever
  //    return the same verdict, an unhealthy base makes every red meaningless,
  //    and a tree the step does not own is not the step's to reset.
  if (wanted.length > 0 && runnerTemplate === undefined) {
    return {
      kind: "no-red-test",
      failedRules: ["no test runner configured (.pi/work.json verify.test)"],
    };
  }
  if (worktreeExists(wt)) {
    try {
      await assertSpecifyWorktreeOwned(deps.exec, { repoRoot, wt, baseSha: base, branch });
    } catch (err) {
      throw new SpecifyInfraError((err as Error).message);
    }
  }

  // 3. The worktree: created at the base, or reset to it. Both paths clean
  //    without exemptions and re-provision, so this is the links the tree has.
  const provisioning = await prepareTree(deps, { repoRoot, issue, wt, base, branch });

  // 4. Base health BEFORE any red is trusted.
  await assertBaseHealthy(deps.exec, wt, config, provisioning);

  // `runnerTemplate` is narrowed to a string by the refusal above (a spec WITH
  // test criteria cannot reach here without one). Checked here, once, so every
  // attempt below is typed against the narrowed binding.
  if (runnerTemplate === undefined)
    throw new SpecifyInfraError("no test runner configured for a spec with test criteria");
  // The run's frozen test record, read ONCE. The quota seed does not change
  // while the boundary runs (nothing commits in between), so reading it per
  // `validate` invocation would just re-fold the step log for the same answer.
  const frozenByCriterion = testsFromLog(ctx.steps);

  // 5-13. One attempt: the adversary under the state's budget (#1883), then
  //       extract, validate, CAPTURE, RESET to the base, REWRITE, prove every
  //       kept file red ON THE BASE, and commit. That pipeline is shared with
  //       `challenge` (see `specify-run.ts`): the two steps differ in whose
  //       tests the child is shown and what the tree is reset to, not in how a
  //       submitted test file is proved and frozen, so there is one copy.
  //
  //       The ref is `base` here: `specify`'s whole claim is that it froze the
  //       tests ON the base, so its `headBefore` IS the base and the child's
  //       work is undone back to the commit `ready` resolved. The two verdicts
  //       the shared pipeline can return are the two this step has always
  //       returned, unchanged: a coverage gap is `no-red-test`, and there is no
  //       third one. `uncovered` reports every criterion the run still owes —
  //       `specify` has required all of them since before the split, so the
  //       pipeline's partial-red case is a refusal here, not a partial freeze.
  //
  //       Returns the boundary's drop reasons too: an attempt that dropped a row
  //       is the only kind of refusal the child can fix by being told about it.
  const attempt = async (refusal?: string[]): Promise<{ outcome: Outcome; refused: string[] }> => {
    // Each dispatch gets its own budget (#1883), armed the way the first was.
    const budget = armBudget(budgetFor(config, "specify"));
    if (budget.warning !== undefined)
      traceWarn(`lean specify #${String(issue)}: ${budget.warning}`);
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
  };

  // At most ONE retry. A refusal that dropped a submitted row is the one
  // the child can fix by reading why, so the adversary is dispatched again with
  // the reasons in its prompt. A budget stop, a clean `ok`, or a refusal that
  // dropped nothing is final on the first attempt. The second attempt's outcome
  // is the step's result whatever it is.
  const first = await attempt();
  if (first.outcome.kind !== "no-red-test" || first.refused.length === 0) return first.outcome;
  // The first attempt's pipeline may have left red files in the tree, and the
  // retry must start from the base exactly as the first did. It is needed:
  // `runTestPipeline` resets only once it has a kept file, so an attempt that
  // kept nothing leaves its writes behind.
  await prepareTree(deps, { repoRoot, issue, wt, base, branch });
  const second = await attempt(first.refused);
  return afterRetry(second.outcome);
}
