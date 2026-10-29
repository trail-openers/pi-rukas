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
 * Two kinds of failure, deliberately apart. `no-red-test` is a VERDICT about
 * the work — the spec or the child's tests are not good enough, and the run
 * ends `not-ready` with named rules. A THROW is infrastructure — an unhealthy
 * base, a worktree the step does not own, a dispatch that died, a commit that
 * did not contain what it was told to — and the engine turns it into
 * handed-back exit 10 without blaming the issue.
 *
 * Everything outside the pure parts is injected, so the test drives a real
 * temp git repo through the same seams production uses.
 */

import { existsSync, rmSync } from "node:fs";
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
import { specifyPrompt, testCriteria } from "./specify-prompt.ts";
import { type Proof, runTestFile, sha256 } from "./specify-proof.ts";
import {
  SpecifyCommitError,
  SpecifyResetError,
  commitTestFiles,
  committedBlob,
  resetWorktreeToBase,
  writeCaptured,
} from "./specify-reset.ts";
import {
  assertSpecifyWorktreeOwned,
  captureTestBytes,
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
   * test can place against the child's own last write.
   */
  capture?: (wt: string, paths: string[]) => Map<string, Buffer>;
}

/** A base, a tree or a child we cannot trust. The engine turns this into 10. */
export class SpecifyInfraError extends Error {
  override readonly name = "SpecifyInfraError";
}

/** The rules a spec fails on re-read, or [] when it still holds. */
function specRules(body: string): { spec?: PiSpec; rules: string[] } {
  const parsed = parsePiSpec(body);
  if (!parsed.ok) return { rules: [`spec: ${parsed.reason}`] };
  return { spec: parsed.spec, rules: readiness(parsed.spec) };
}

/** One line per dropped row or file, for the outcome reason. */
function dropNote(dropped: { criterionId: string; path?: string; reason: string }[]): string {
  if (dropped.length === 0) return "";
  const parts = dropped
    .slice(0, 8)
    .map((d) => `${d.criterionId}${d.path === undefined ? "" : ` ${d.path}`}: ${d.reason}`);
  const more = dropped.length - parts.length;
  return ` dropped ${dropped.length}${more > 0 ? ` (${more} more)` : ""} — ${parts.join("; ")}`;
}

/** A runner that could not be started, or was killed: a toolchain fault. */
const INFRA_DETAIL = /could not be started|killed or timed out|nothing to run/;

/**
 * A non-red run of one captured file, phrased as the step's reason for it.
 *
 * The old classifier here also threw on any output mentioning `node_modules`
 * or `Cannot find module` — which is exactly what the canonical TDD red prints
 * when a test imports a module nobody has written yet. That arm is gone. An
 * unrunnable runner is the only thing that still throws, and it is recognised
 * by the proof's own words rather than by the test's output, so a test that
 * prints those phrases can never be mistaken for a broken toolchain.
 */
function proofNote(cand: { criterionId: string; path: string }, proof: Proof): string {
  if (proof.kind === "infra" && INFRA_DETAIL.test(proof.detail))
    throw new SpecifyInfraError(`the test runner could not run ${cand.path}: ${proof.detail}`);
  return `${cand.criterionId} ${cand.path}: ${proof.detail}`;
}

/** Remove `rel` from the worktree; returns the reason it is still there, if any. */
function removeRejected(wt: string, rel: string): string | undefined {
  if (!existsSync(path.join(wt, rel))) return undefined;
  try {
    rmSync(path.join(wt, rel));
  } catch (err) {
    return `could not remove the rejected test ${rel}: ${(err as Error).message}`;
  }
  if (existsSync(path.join(wt, rel))) return `the rejected test ${rel} could not be removed`;
  return undefined;
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
  const template = config.verify.test;

  // 2. The preconditions, all of them BEFORE the dispatch. Each one is a fact
  //    the step can establish for itself, and an adversary spends tokens
  //    proving none of them: a run with no runner configured could only ever
  //    return the same verdict, an unhealthy base makes every red meaningless,
  //    and a tree the step does not own is not the step's to reset.
  if (wanted.length > 0 && template === undefined) {
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

  // 3. The worktree: created at the base, or reset to it.
  let linked: string[] = [];
  let provisioning: { linked: string[]; problem?: string } | undefined;
  try {
    const prepared = await ensureSpecifyWorktreeWithProvision(deps.exec, {
      repoRoot,
      issue,
      fromRef: base,
      branch,
    });
    linked = prepared.linked;
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
    testRunner: template,
  });

  // 6. Extract and validate at the boundary. A row whose path is not an
  //    ordinary file of THIS worktree is dropped here, before a single byte of
  //    it is read.
  const { rows, skipped } = extractSubmitTests(toolUses);
  const { kept, dropped } = validateSubmitRows(rows, {
    spec,
    exists: (rel) => existsSync(path.join(wt, rel)),
    fileProblem: (rel) => fileProblem(wt, rel),
  });
  const notes: string[] = [];
  const candidates = declaredPaths(
    Object.fromEntries(kept.map((row) => [row.criterionId, row.testFiles])),
  );

  // 7. CAPTURE: the bytes of every kept file, in memory. Nothing else the
  //    child produced survives what comes next.
  let captured: Map<string, Buffer>;
  try {
    captured = (deps.capture ?? captureTestBytes)(
      wt,
      candidates.map((c) => c.path),
    );
  } catch (err) {
    throw new SpecifyInfraError((err as Error).message);
  }

  // 8. RESET to base — the child's commits, its staging, its untracked files
  //    and its ignore rules all go, and the reset is confirmed before anything
  //    is written back.
  try {
    await resetWorktreeToBase(deps.exec, wt, base, branch, linked);
    // 9. REWRITE the captured bytes. Plain writes; no links, no renames.
    writeCaptured(wt, captured);
  } catch (err) {
    if (err instanceof SpecifyResetError) throw new SpecifyInfraError(err.message);
    throw new SpecifyInfraError(
      `could not rewrite the captured tests in ${wt}: ${(err as Error).message}`,
    );
  }

  // 10. Prove red on exactly these bytes, per file. A green or unclear file is
  //     dropped and DELETED from the tree; only a runner that could not be
  //     started (or was killed) is infrastructure.
  const red: typeof candidates = [];
  for (const cand of candidates) {
    const proof = await runTestFile(deps.exec, {
      wt,
      template: template as string,
      file: cand.path,
    });
    if (proof.kind === "red") {
      red.push(cand);
      continue;
    }
    notes.push(proofNote(cand, proof));
    const why = removeRejected(wt, cand.path);
    if (why !== undefined) notes.push(why);
  }

  // 11. Coverage: every test criterion needs at least one red file.
  const uncovered = wanted.filter((c) => !red.some((r) => r.criterionId === c.id)).map((c) => c.id);
  const skippedNote = skipped > 0 ? ` (${skipped} malformed submit_tests call(s))` : "";
  if (uncovered.length > 0) {
    const why = uncovered.map((id) => `criterion ${id} has no red test${skippedNote}`);
    return {
      kind: "no-red-test",
      failedRules: why,
      reason: [...why, ...notes].join(";") + dropNote(dropped),
    };
  }

  // 12. COMMIT the kept files, and assert the commit is exactly them.
  const paths = [...new Set(red.map((r) => r.path))];
  try {
    await commitTestFiles(deps.exec, wt, base, paths, `test: acceptance tests for #${issue}`);
  } catch (err) {
    if (err instanceof SpecifyCommitError) throw new SpecifyInfraError(err.message);
    throw new SpecifyInfraError(`could not commit the acceptance tests: ${(err as Error).message}`);
  }

  // 13. HASH the COMMITTED blobs, not the working files: what the rest of the
  //     run compares against has to describe the commit, not whatever was on
  //     disk when the step happened to look.
  const frozen: Record<string, string> = {};
  const tests: Record<string, string[]> = {};
  for (const { criterionId, path: rel } of red) {
    frozen[rel] = sha256(await committedBlob(deps.exec, wt, rel));
    const list = tests[criterionId] ?? [];
    if (!list.includes(rel)) list.push(rel);
    tests[criterionId] = list;
  }

  const reason = [
    `froze ${Object.keys(frozen).length} red test file(s) for ${Object.keys(tests).length} criterion/criteria`,
    skipped > 0 ? `${skipped} submit_tests call(s) skipped or refused as malformed` : "",
    notes.length > 0 ? `dropped ${notes.length} non-red file(s): ${notes.join("; ")}` : "",
    dropNote(dropped),
  ]
    .filter((s) => s !== "")
    .join("; ");
  return { kind: "ok", frozen, tests, reason };
}
