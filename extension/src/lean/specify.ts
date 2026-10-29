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
 *   2. put a clean worktree at the run's base sha (create, or reset a leftover);
 *   3. prove the BASE healthy — the pinned compiler's canary and the project's
 *      fast verify tier. A red test is only evidence when the base builds, so
 *      this runs BEFORE anything is dispatched;
 *   4. dispatch ONE adversary that writes the tests and submits them;
 *   5. validate every submitted row at the boundary and revert everything the
 *      child touched that it did not submit;
 *   6. run each kept file on the base and keep only the ones that fail for the
 *      stated behaviour;
 *   7. every `verify: "test"` criterion must have at least one red file, or the
 *      step refuses the run;
 *   8. freeze: hash the kept files, commit exactly those, and return the record
 *      `build` and `verify` read back.
 *
 * Two kinds of failure, deliberately apart. `no-red-test` is a VERDICT about
 * the work — the spec or the child's tests are not good enough, and the run
 * ends `not-ready` with named rules. A THROW is infrastructure — an unhealthy
 * base, an unreadable worktree, a dispatch that died — and the engine turns it
 * into handed-back exit 10 without blaming the issue.
 *
 * Everything outside the pure parts is injected, so the test drives a real
 * temp git repo through the same seams production uses.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { statReporterPath } from "../reporter-preflight.ts";
import type { DispatchResult, DispatchSpec } from "../types.ts";
import { guardCompilerIntegrity } from "../work-driver-toolchain-canary.ts";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import type { WorkConfig } from "./config.ts";
import { loadWorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { type PiSpec, parsePiSpec, readiness } from "./spec.ts";
import { specifyPrompt, testCriteria } from "./specify-prompt.ts";
import { hashFile, runTestFile } from "./specify-proof.ts";
import {
  changedPaths,
  declaredPaths,
  ensureSpecifyWorktree,
  revertUndeclared,
  specifyBranch,
  specifyWorktreePath,
  validateSubmitRows,
} from "./specify-tree.ts";
import type { Outcome } from "./state.ts";
import { extractSubmitTests } from "./submit-tests-extract.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "./submit-tests-reporter.ts";

export const SUBMIT_TESTS_TOOL = "submit_tests";

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
  now: () => number;
  /** Preflight for the reporter companion; `statReporterPath` in production. */
  statReporter?: (p: string) => Promise<unknown>;
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

/** One line per dropped row, for the outcome reason. */
function dropNote(dropped: { criterionId: string; path?: string; reason: string }[]): string {
  if (dropped.length === 0) return "";
  const parts = dropped
    .slice(0, 8)
    .map((d) => `${d.criterionId}${d.path === undefined ? "" : ` ${d.path}`}: ${d.reason}`);
  const more = dropped.length - parts.length;
  return ` dropped ${dropped.length}${more > 0 ? ` (${more} more)` : ""} — ${parts.join("; ")}`;
}

/** Base health: the compiler canary (when the tier uses it) then the fast tier. */
async function assertBaseHealthy(exec: ExecFn, wt: string, config: WorkConfig): Promise<void> {
  const fast = config.verify.fast;
  if (fast === undefined) return;
  const guard = await guardCompilerIntegrity({ cmd: fast, cwd: wt, where: wt, run: exec });
  if (guard?.failure !== undefined) throw new SpecifyInfraError(`base unhealthy: ${guard.failure}`);
  // The shell form: a verify tier is a shell command line (`cd pkg && node
  // …/tsc --noEmit && bun run test`), not one executable plus argv, and it is
  // the project's own command that says whether this base builds at all.
  const ran = await exec(fast, {
    cwd: wt,
    timeout: 30 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((err: unknown) => ({ __err: err }) as never);
  if ((ran as { __err?: unknown })?.__err !== undefined) {
    const e = (ran as { __err?: { stderr?: string; message?: string } }).__err;
    throw new SpecifyInfraError(
      `base unhealthy: verify.fast failed in ${wt}: ${(e?.stderr ?? e?.message ?? "unknown error")
        .replace(/\s+/g, " ")
        .slice(0, 400)}`,
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

/** Prove each kept file red on base; returns the keeps, and the reasons for the rest. */
async function proveKept(
  deps: SpecifyDeps,
  wt: string,
  template: string,
  candidates: { criterionId: string; path: string }[],
): Promise<{ red: { criterionId: string; path: string }[]; notes: string[] }> {
  const red: { criterionId: string; path: string }[] = [];
  const notes: string[] = [];
  for (const cand of candidates) {
    const proof = await runTestFile(deps.exec, { wt, template, file: cand.path });
    if (proof.kind === "infra")
      throw new SpecifyInfraError(
        `base unhealthy: ${cand.path} could not be run (${proof.detail})`,
      );
    if (proof.kind === "red") {
      red.push(cand);
      continue;
    }
    notes.push(`${cand.criterionId} ${cand.path}: ${proof.detail}`);
  }
  return { red, notes };
}

/** Freeze: hash the kept files, commit exactly those, and record them. */
async function freeze(
  deps: SpecifyDeps,
  wt: string,
  issue: number,
  red: { criterionId: string; path: string }[],
): Promise<{ frozen: Record<string, string>; tests: Record<string, string[]> }> {
  const frozen: Record<string, string> = {};
  const tests: Record<string, string[]> = {};
  for (const { criterionId, path: rel } of red) {
    const sha = hashFile(path.join(wt, rel));
    if (sha === undefined) throw new SpecifyInfraError(`could not hash ${rel} in ${wt}`);
    frozen[rel] = sha;
    const list = tests[criterionId] ?? [];
    if (!list.includes(rel)) list.push(rel);
    tests[criterionId] = list;
  }
  const paths = Object.keys(frozen);
  if (paths.length > 0) {
    await deps.exec("git", {
      argv: ["add", "--", ...paths],
      cwd: wt,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    // The pathspec is on the COMMIT, not just the add. Without it the commit
    // takes whatever the index holds, and the index also holds whatever the
    // child staged for itself — so a child that ran `git add` on its own stray
    // edit shipped that edit in the "acceptance tests" commit and the test
    // files stayed uncommitted. Naming the frozen paths makes the commit
    // contain exactly what the step proved red, whatever the child staged.
    await deps.exec("git", {
      argv: ["commit", "-m", `test: acceptance tests for #${issue}`, "--", ...paths],
      cwd: wt,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  }
  return { frozen, tests };
}

/**
 * The `specify` step. Returns `ok` | `no-red-test`; THROWS on infrastructure.
 */
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

  // 2. A clean worktree at the base, created or reset.
  const branch = specifyBranch(ctx.run.branch, issue);
  const wt = specifyWorktreePath(repoRoot, issue);
  try {
    await ensureSpecifyWorktree(deps.exec, { repoRoot, issue, fromRef: base, branch });
  } catch (err) {
    throw new SpecifyInfraError(`could not prepare the worktree ${wt}: ${(err as Error).message}`);
  }

  // 3. Base health BEFORE any red is trusted.
  await assertBaseHealthy(deps.exec, wt, config);

  // 4. The adversary.
  const toolUses = await dispatchAdversary(deps, {
    issue,
    spec,
    wt,
    repoRoot,
    testRunner: config.verify.test,
  });

  // 5. Extract, validate at the boundary, and revert everything undeclared.
  const { rows, skipped } = extractSubmitTests(toolUses);
  const { kept, dropped } = validateSubmitRows(rows, {
    spec,
    exists: (rel) => existsSync(path.join(wt, rel)),
  });
  const dropNoteText = dropNote(dropped);
  const candidates = declaredPaths(
    Object.fromEntries(kept.map((row) => [row.criterionId, row.testFiles])),
  );
  const reverted = await revertUndeclared(deps.exec, wt, new Set(candidates.map((c) => c.path)));

  // 7. A runner is required whenever the spec asks for tests at all.
  const wanted = testCriteria(spec);
  const template = config.verify.test;
  if (template === undefined) {
    if (wanted.length === 0)
      return { kind: "no-red-test", failedRules: ["no test criteria in the spec"] };
    return {
      kind: "no-red-test",
      failedRules: ["no test runner configured (.pi/work.json verify.test)"],
    };
  }

  // 6. Prove red on base. An infra result throws; a green or unclear file is
  //    dropped and named in the reason.
  const stillThere = candidates.filter((c) => existsSync(path.join(wt, c.path)));
  const { red, notes } = await proveKept(deps, wt, template, stillThere);

  // 8. Coverage: every test criterion needs at least one red file.
  const uncovered = wanted.filter((c) => !red.some((r) => r.criterionId === c.id)).map((c) => c.id);
  if (uncovered.length > 0) {
    const why = uncovered.map(
      (id) =>
        `criterion ${id} has no red test${skipped > 0 ? ` (${skipped} malformed submit_tests call(s))` : ""}`,
    );
    return {
      kind: "no-red-test",
      failedRules: why,
      reason: [...why, ...notes].join(";") + dropNoteText,
    };
  }

  // 9. Freeze and commit.
  const { frozen, tests } = await freeze(deps, wt, issue, red);
  const left = await changedPaths(deps.exec, wt);
  const reason = [
    `froze ${Object.keys(frozen).length} red test file(s) for ${Object.keys(tests).length} criterion/criteria`,
    reverted.length > 0
      ? `reverted ${reverted.length} undeclared path(s): ${reverted.join(", ")}`
      : "",
    notes.length > 0 ? `dropped ${notes.length} non-red file(s): ${notes.join("; ")}` : "",
    dropNoteText,
    left.length > 0 ? `warning: worktree still reports ${left.length} changed path(s)` : "",
  ]
    .filter((s) => s !== "")
    .join("; ");
  return { kind: "ok", frozen, tests, reason };
}
