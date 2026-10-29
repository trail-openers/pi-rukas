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
import type { DispatchResult, DispatchSpec } from "../types.ts";
import { guardCompilerIntegrity, packageDirFor } from "../work-driver-toolchain-canary.ts";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import type { WorkConfig } from "./config.ts";
import { loadWorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { type PiSpec, parsePiSpec, readiness } from "./spec.ts";
import type { CaptureResult } from "./specify-capture.ts";
import { specifyPrompt, testCriteria } from "./specify-prompt.ts";
import type { TestRunLimits } from "./specify-proof.ts";
import { SpecifyResetError } from "./specify-reset.ts";
import { SpecifyInfraError, runTestPipeline } from "./specify-run.ts";
import {
  assertSpecifyWorktreeOwned,
  declaredPaths,
  ensureSpecifyWorktreeWithProvision,
  fileProblem,
  specifyBranch,
  specifyWorktreePath,
  validateSubmitRows,
  worktreeExists,
} from "./specify-tree.ts";
import type { Outcome } from "./state.ts";
import { extractSubmitTests } from "./submit-tests-extract.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "./submit-tests-reporter.ts";

/** The dispatch seam: one child, one result. `spawnSpecialist` in production. */
export type SpecifyDispatch = (
  spec: DispatchSpec,
  opts: { writeFence?: WriteFence; extraArgs?: readonly string[] },
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
  opts: { issue: number; spec: PiSpec; wt: string; repoRoot: string; testRunner?: string },
): Promise<unknown[]> {
  await (deps.statReporter ?? statReporterPath)(SUBMIT_TESTS_REPORTER_PATH);
  const prompt = specifyPrompt({
    issue: opts.issue,
    spec: opts.spec,
    testRunner: opts.testRunner,
    worktree: opts.wt,
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
    },
  );
  if (!result.ok || result.killCause !== undefined || result.errorStop !== undefined) {
    const why =
      result.killCause ??
      result.errorStop?.message ??
      result.errorStop?.reason ??
      `exit ${String(result.exitCode)}`;
    throw new SpecifyInfraError(`specify dispatch failed: ${String(why)}`);
  }
  return result.toolUses ?? [];
}

/** The `specify` step. Returns `ok` | `no-red-test`; THROWS on infrastructure. */
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
  let provisioning: { linked: string[]; problem?: string } | undefined;
  try {
    const prepared = await ensureSpecifyWorktreeWithProvision(deps.exec, {
      repoRoot,
      issue,
      fromRef: base,
      branch,
    });
    if (prepared.problem !== undefined)
      provisioning = { linked: prepared.linked, problem: prepared.problem };
  } catch (err) {
    if (err instanceof SpecifyResetError) throw new SpecifyInfraError(err.message);
    throw new SpecifyInfraError(`could not prepare the worktree ${wt}: ${(err as Error).message}`);
  }

  // 4. Base health BEFORE any red is trusted.
  await assertBaseHealthy(deps.exec, wt, config, provisioning);

  // 5. The adversary.
  const toolUses = await dispatchAdversary(deps, {
    issue,
    spec,
    wt,
    repoRoot,
    testRunner: runnerTemplate,
  });

  // 6-13. Extract, validate, CAPTURE, RESET to the base, REWRITE, prove every
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
  //       `runnerTemplate` is narrowed to a string by the refusal above (a spec
  //       WITH test criteria cannot reach here without one), and TypeScript
  //       cannot carry that narrowing across the object literal below, so it is
  //       restated at the call site that needs it rather than cast away.
  if (runnerTemplate === undefined)
    throw new SpecifyInfraError("no test runner configured for a spec with test criteria");
  const pipeline = await runTestPipeline(
    {
      exec: deps.exec,
      wt,
      repoRoot,
      issue,
      branch,
      headBefore: base,
      runnerTemplate,
      wanted: wanted.map((c) => c.id),
      extract: extractSubmitTests,
      validate: (rows) =>
        validateSubmitRows(rows, {
          spec,
          exists: (rel) => existsSync(path.join(wt, rel)),
          fileProblem: (rel) => fileProblem(wt, rel),
        }),
      prepare: () =>
        ensureSpecifyWorktreeWithProvision(deps.exec, { repoRoot, issue, fromRef: base, branch }),
      commitMessage: `test: acceptance tests for #${issue}`,
      ...(deps.capture === undefined ? {} : { capture: deps.capture }),
      ...(deps.testLimits === undefined ? {} : { testLimits: deps.testLimits }),
    },
    { toolUses },
  );
  if (pipeline.kind === "committed")
    return { kind: "ok", frozen: pipeline.frozen, tests: pipeline.tests, reason: pipeline.reason };
  if (pipeline.kind === "uncovered")
    return { kind: "no-red-test", failedRules: pipeline.uncovered, reason: pipeline.reason };
  // No kept candidate at all. Every criterion is uncovered, which is the same
  // refusal this step returned before the split for the same cause.
  return {
    kind: "no-red-test",
    failedRules: wanted.map((c) => `criterion ${c.id} has no red test`),
    reason: pipeline.reason,
  };
}
