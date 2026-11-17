/**
 * lean/challenge — one adversary round after build, against the current head.
 *
 * `specify` proves a spec is falsifiable before anybody codes. `challenge` asks the
 * sharper question afterwards: the builder says it is done, the frozen tests pass,
 * and is there a case the frozen tests never thought of that still fails? A round
 * that finds one buys a second build against a real gap; a round that finds nothing
 * cost one dispatch and confirmed nothing was found by an adversary paid to look.
 * That asymmetry is why `none` is a VERDICT and not an error — and why the step
 * commits nothing in that case: nothing was proved to fail.
 *
 * The machinery is `specify`'s, unchanged, and lives in `specify-run.ts` for both
 * steps. The one thing `challenge` passes differently is the ref: `specify` resets
 * to the run's base sha (red-on-nothing), `challenge` to the current head
 * (red-on-the-code-that-claims-to-be-done).
 *
 * The differences that ARE challenge's own:
 *
 *   1. **Preconditions before the dispatch** — the frozen map is non-empty and every
 *      frozen blob still hashes to its record AT THE HEAD (build's
 *      `assertFrozenIntact`, the same claim build refuses to build without), the
 *      worktree is this run's and sits at that head, and the runner template exists.
 *      A child is never paid to work in a tree the step cannot account for, nor to
 *      attack an implementation whose tests were edited.
 *   2. **The adversary may not replace a frozen test.** It is shown the frozen paths
 *      and asked for NEW files, and a submission naming a frozen path is refused at
 *      the boundary (`frozenPaths` into `validateSubmitRows`) — the child is not
 *      trusted to obey its own prompt about the one file that would rewrite the
 *      contract.
 *   3. **The red proof is the round's verdict.** Green or unclear means the builder
 *      already handles that case, so the file is dropped; infra throws. Nothing
 *      survives the proof and nothing is committed ⇒ `none`.
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
import { existsInCommit, fileProblem, pathProblem } from "./specify-path.ts";
import { testCriteria } from "./specify-prompt.ts";
import type { TestRunLimits } from "./specify-proof.ts";
import { SpecifyResetError, resetWorktreeToBase } from "./specify-reset.ts";
import { SpecifyInfraError, noteClause, runTestPipeline } from "./specify-run.ts";
import { type SubmoduleNote, submoduleNoteClause } from "./specify-submodules.ts";
import { changedPaths } from "./specify-tree.ts";
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
 * What `headSha` must return before any of it may be used: a git commit id. Everything downstream —
 * `rev-parse HEAD^`, `diff <sha> <sha>`, `show <sha>:<p>` — reinterprets a non-id as a REF, so `"main"` coming
 * back from `rev-parse` would silently retarget the whole round at another commit instead of failing.
 */
const COMMIT_ID = /^[0-9a-f]{40}$/;

/** The control characters `handback.ts` refuses to print in a path. */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
);

/** What the contract re-read from the forge gave the challenge step. */
interface SpecRead {
  spec: PiSpec;
  /**
   * The body it was parsed from, kept for the adversary's brief — the SAME fetch, never a second one
   * (`lean/issue-prose.ts`).
   */
  body: string;
}

/** The spec, re-read from the forge — the same contract the builder worked to. */
async function specOf(deps: ChallengeDeps, repoRoot: string, issue: number): Promise<SpecRead> {
  let body: string;
  try {
    body = await deps.fetchIssueBody(repoRoot, issue);
  } catch (err) {
    throw new ChallengeInfraError(`could not read the issue: ${(err as Error).message}`);
  }
  const parsed = parsePiSpec(body);
  if (!parsed.ok) throw new ChallengeInfraError(`the issue's spec is unusable: ${parsed.reason}`);
  // The SAME readiness judgement `specify` gates the run on, applied on re-read. The issue is editable while
  // the run goes, so a spec ready at `ready` need not be ready now — and the round's claim is stated against
  // these criteria. A spec that stops being well-formed cannot be adjudicated: infrastructure, not a verdict.
  const rules = readiness(parsed.spec);
  if (rules.length > 0)
    throw new ChallengeInfraError(`the issue's spec is not ready: ${rules.join("; ")}`);
  return { spec: parsed.spec, body };
}

// A round can end holding bytes nobody judged, and `verify` refuses a dirty tree: reset to `ref` and provision
// again (`clean -fdx` takes the links, so the two are one move), naming what went. The reset runs whether or not
// the tree was dirty: an `empty` round committed nothing, so a HEAD above `ref` is the child's own unjudged
// commit and goes with it. Names come from `changedPaths` (git's `-z` status, the only form surviving a space,
// quote or newline); one failing the boundary's path rules or `handback.ts`'s control-character filter is
// dropped, not clipped, since the reason reaches the issue as a public comment.
async function resetAndProvision(
  deps: ChallengeDeps,
  repoRoot: string,
  wt: string,
  ref: string,
  branch: string,
): Promise<string> {
  const dirty = await changedPaths(deps.exec, wt);
  // Read before the reset and compared to `ref`, not a fresh HEAD.
  const head = await headSha(deps.exec, wt);
  const shown = [...new Set(dirty.map((e) => e.path))].filter(
    (p) => pathProblem(p) === undefined && !CONTROL_CHARS.test(p),
  );
  const clause = noteClause("discarded", shown);
  // One outcome for the pair: a failed reset leaves a provision of a tree nobody cleaned and `verify` refuses
  // that dirty. (The budget stop below runs the two moves as two `try`s, each with its own message, naming
  // nothing.)
  let notes: readonly SubmoduleNote[] = [];
  try {
    notes = await resetWorktreeToBase(deps.exec, wt, ref, branch);
    await provisionWorktree(deps.exec, repoRoot, wt);
  } catch (err) {
    throw new ChallengeInfraError(`could not reset the challenge tree: ${(err as Error).message}`);
  }
  // A submodule the reset could not populate is said HERE, in the round's own reason and not only the trace:
  // this step pays an adversary to attack tests it may not be able to collect, so "the tree had no submodule at
  // `vendor/x`" belongs beside the verdict, not in another step's log.
  const submodule = submoduleNoteClause(notes);
  return [
    dirty.length === 0 && head === ref ? "" : clause === "" ? "" : ` ${clause}`,
    submodule === undefined ? "" : ` ${submodule}`,
  ].join("");
}

/**
 * The tree, the head, and the two claims that must hold before a child is paid: this worktree is ours at THIS
 * commit, and the frozen contract still matches it.
 *
 * Both are `build`'s checks from the same functions: an adversary is expensive and proves neither, and paying
 * one to attack an implementation whose tests were quietly edited would report `none` — a certification from a
 * tree nobody verified.
 *
 * `frozen` is passed IN rather than read here: the map is the step log's, and a precondition re-deriving it
 * would be a second reader of the record.
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
  // Validate BEFORE the value reaches anything: it is the ref this step resets to, proves red against, and
  // commits on top of.
  if (!COMMIT_ID.test(headBefore))
    throw new ChallengeInfraError(
      `HEAD is not a commit id: ${JSON.stringify(headBefore)} in ${wt}`,
    );
  try {
    // `headMustBe = headBefore`: registered, on the run's branch, at the head the frozen records were hashed
    // at. Build passes the same pair — a tree at any other commit is not this run's to write into.
    await assertSpecifyWorktreeOwned(deps.exec, {
      repoRoot,
      wt,
      baseSha: base,
      branch,
      headMustBe: headBefore,
    });
    // Non-empty and still hashing to its records at the head: the identical claim build refuses to build on.
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
  // The same record read per criterion: the file quota is a RUN-level bound, so what an earlier round froze
  // for a criterion counts against it and a second challenge round cannot double the cap by being a second
  // call. A resumed run seeds from what a crashed one froze, as `frozen` above does. Same log reader.
  const frozenByCriterion = testsFromLog(ctx.steps);
  const branch = specifyBranch(ctx.run.branch, issue);
  const wt = specifyWorktreePath(repoRoot, issue);
  const base = ctx.run.baseSha;
  // Everything below — ownership, the frozen check, the reset, the red proof — is stated against the CURRENT
  // head, not the base: the base lacks the implementation, and a test red there proves nothing about code that
  // does not exist there.
  const headBefore = await assertTreeAndContract(deps, {
    repoRoot,
    wt,
    branch,
    base,
    frozen,
  });

  // 2. Config and runner BEFORE the child is paid: without a template every submitted file proves nothing, so
  //    the round could only report `none` — not a verdict about the code, a missing setting.
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new ChallengeInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const { spec, body: issueBody } = await specOf(deps, repoRoot, issue);
  const wanted = testCriteria(spec);
  // ONE binding, ONE refusal: `runnerTemplate` is the string the runner needs and `testRunner` the same string
  // shown to the adversary, so exactly one place decides it is missing. A round whose files nobody executed can
  // only report `none` — a missing setting wearing a verdict, so the refusal names the setting.
  const runnerTemplate: string | undefined = config.verify.test;
  const testLocation: TestLocation | undefined = testLocationOf(config.verify);
  if (runnerTemplate === undefined)
    throw new ChallengeInfraError(
      "no test runner configured (.pi/work.json verify.test) for a spec with test criteria",
    );

  // 3. The adversary, under the state's budget.
  const budget = armBudget(budgetFor(config, "challenge"));
  if (budget.warning !== undefined)
    traceWarn(`lean challenge #${String(issue)}: ${budget.warning}`);
  // The adversary's cost row rides on the throw and `settle` records it (see `build.ts`).
  const [adversary, row] = await dispatchAdversary(deps.dispatch, {
    issue,
    spec,
    issueBody,
    frozenPaths: Object.keys(frozen),
    wt,
    repoRoot,
    testRunner: runnerTemplate,
    budget,
    ...(testLocation === undefined ? {} : { testLocation }),
    ...(deps.statReporter === undefined ? {} : { statReporter: deps.statReporter }),
  });
  const rows = [row];
  const read = readDispatched(adversary);
  if ("stop" in read) {
    // The stop returned before the pipeline, so nothing has reset what the child wrote. Both moves are
    // UNCONDITIONAL (`clean -fdx` takes the dependency links, so even a clean-looking tree needs them rebuilt)
    // and each keeps its own message: a failed reset and a failed provision are different repairs.
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
      // The round's claim is ONE red edge case, not a red per criterion: a finding for AC1 is worth freezing
      // even when AC2 has none. `specify` passes `"all-criteria"` and keeps its refusal; this step must not.
      coverage: "any-red",
      wanted: wanted.map((c) => c.id),
      extract: extractSubmitTests,
      validate: (rows) =>
        validateSubmitRows(rows, {
          spec,
          exists: (rel) => existsSync(path.join(wt, rel)),
          fileProblem: (rel) => fileProblem(wt, rel),
          // The refusal keeping the adversary out of the contract: a path the run froze is not its to replace,
          // whatever the prompt said. On the NORMALISED path, so `./tests//AC1-retry.test.sh` cannot slip past
          // as a name the set does not contain.
          frozenPaths: new Set(Object.keys(frozen)),
          // The same newness rule as `specify` against the same BASE: an edge case the adversary did not write
          // is not one, and the base is where a pre-existing file shows for what it is. At the head every test
          // of the run is present, so the head cannot answer this.
          existsAtBase: (rel) => existsInCommit(deps.exec, repoRoot, base, rel),
          // Same size/quota rules as `specify`: a 1,000-line edge case is not one, and a criterion does not
          // get four files ACROSS THE RUN — hence the seed, so files the run froze fill the quota rather than
          // a fresh allowance per round.
          wt,
          frozenByCriterion,
          ...(testLocation === undefined ? {} : { testLocation }),
        }),
      // Provisioning is `challenge`'s own call and the `prepare` the pipeline re-runs after its reset is the
      // same one: one code path builds the dependency links a clean removed, whether the tree was made here or
      // survived a crash.
      prepare: () =>
        ensureSpecifyWorktreeWithProvision(deps.exec, {
          repoRoot,
          issue,
          fromRef: headBefore,
          branch,
        }),
      commitMessage: `test: challenge tests for #${issue}`,
      // The same gate `specify` applies: an adversary's file is frozen on the same terms, and a file `build`
      // may not edit is unwinnable whoever wrote it.
      ...(config.verify.freezeCheck === undefined
        ? {}
        : { freezeCheck: config.verify.freezeCheck }),
      ...(deps.testLimits === undefined ? {} : { testLimits: deps.testLimits }),
    },
    { toolUses },
  );

  // The one exit that never reached the pipeline's own reset. The sweep goes back to `headBefore`, not a
  // re-read HEAD: an `empty` round committed NOTHING, so a commit above it is the child's unjudged work and is
  // discarded too. A committed round needs no sweep — `runTestPipeline` resets and writes back only what it
  // proved red — and `uncovered` is the throw.
  const swept =
    pipeline.kind === "empty"
      ? await resetAndProvision(deps, repoRoot, wt, headBefore, branch)
      : "";

  if (pipeline.kind === "committed")
    return {
      kind: "new-tests",
      frozen: pipeline.frozen,
      tests: pipeline.tests,
      reason: pipeline.reason,
      dispatches: rows,
    };
  // Every pipeline kind is named here deliberately: `uncovered` is unreachable under `"any-red"` (that rule
  // never returns it), and a `switch` falling through to `none` would let a future verdict kind be reported as
  // "the adversary found nothing". Each kind gets its own line so adding one is a type error, not a silent
  // certification.
  if (pipeline.kind === "uncovered")
    throw new ChallengeInfraError(
      `the challenge pipeline reported an uncovered criterion, which its coverage rule cannot produce: ${pipeline.reason}`,
    );
  // Nothing was proved red against the head — no file survived the boundary, or the builder handles every
  // one. Both say the same to the machine: the round found no gap, so the run goes to verify with the contract
  // it had and nothing committed. NOT an error, and the reason must say so plainly enough to tell apart from a
  // round that never ran.
  return { kind: "none", reason: pipeline.reason + swept, dispatches: rows };
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
        // Forwarded so the ceiling binds the child, `budgetTurns` included: the turns ceiling is the
        // denominator of the budget-progress steer, and a seam forwarding arms key by key must forward it too
        // or the adversary is killed at its ceiling never told where it stood.
        childBoundMs: o.childBoundMs,
        signal: o.signal,
        onProgress: o.onProgress,
        budgetTurns: o.budgetTurns,
        // The budget's kill goes through `killProcessTree`, reaching the child's tool tree only when the child
        // leads its own group.
        processGroup: true,
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
  };
}
