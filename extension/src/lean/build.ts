/**
 * lean/build — the step that dispatches ONE developer to make the frozen acceptance
 * tests pass.
 *
 * Where `specify` is an adversary writing tests nobody has implemented, `build` is a
 * builder writing the implementation against tests that already exist and are already
 * committed. The step writes no code and runs no tests: `verify` is a separate step
 * that re-runs the frozen files itself. What build owns is the boundary around the
 * child — the tree it hands the child, the prompt it gets, and the single commit that
 * comes out the other side.
 *
 * The whole handler is: read the record, prove the tree, dispatch, normalise, commit.
 * In order, because each stage exists so the next one cannot be fooled:
 *
 *   1. **The frozen map comes from the step log**, not a closure: the union, in order,
 *      of the `frozen` maps of every decided `specify:ok` and `challenge:new-tests`
 *      step. A resumed run sees what a crashed run froze.
 *   2. **The worktree must be the run's own** — registered, on the run's branch, and
 *      sitting at the head the frozen records were hashed at, not the base: the commit
 *      `specify` put on top of it IS the contract now.
 *   3. **The preconditions run before the dispatch**: the frozen map is non-empty and
 *      every frozen blob at that head still hashes to its record.
 *   4. **One child**, role `developer`, fenced to the worktree. A child that died
 *      mid-work is infrastructure and throws; a killed or quota-stopped one is never
 *      re-dispatched, and only a child that died before its first turn gets the one
 *      free re-dispatch (`build-dispatch.ts`).
 *   5. **Normalise and commit** (`build-normalise.ts`): CAPTURE the child's files,
 *      RESET the tree to `headBefore` — undoing its commits, staging, every frozen and
 *      protected-path edit — then REWRITE the captured bytes and make one provable
 *      commit.
 *   6. A child that produced nothing is `exhausted`, which the table routes — not a
 *      throw, not a green. A child its OWN ceiling stopped is `budget`: its work is
 *      folded and committed, and the step retries it in place while the round budget
 *      allows.
 *
 * The re-entry context comes from the log too, clipped to 4 KB.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  BUILD_REASK_BOUND_MS,
  buildReaskClause,
  buildReaskPrompt,
  buildTurnWasWasted,
} from "../build-reask.ts";
import { askBuildReask } from "../build-reask-child.ts";
import { spawnDeveloperContinuationChild } from "../developer-session-continuation.ts";
import type { DeveloperContinuationFn } from "../developer-session-continuation.ts";
import { execp } from "../exec.ts";
import {
  addedByChallengeFromLog,
  budgetStopFromLog,
  frozenFromLog,
  reentryFromLog,
  testsFromLog,
} from "../lean-log.ts";
import { continuationBoundMs, continuationRow } from "../fixer-truncation.ts";
import { armsStepBudget, stepDispatchArms, stopReasonClause } from "../lean-step-bound.ts";
import { spawnSpecialist } from "../spawn.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchSpec } from "../types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { foldStoppedBuild, judgeBlockedReport } from "./build-blocked.ts";
import { dispatchBuilder } from "./build-dispatch.ts";
import { BuildInfraError } from "./build-errors.ts";
import { headSha } from "./build-git.ts";
import { assertFrozenIntact, normaliseBuild } from "./build-normalise.ts";
import { budgetFoldAccumulator, failingClause, foldClauses, keptClause } from "./build-reasons.ts";
import type { BuildDispatch, BuildExec, NormaliseReport } from "./build-types.ts";
import { leanChildOpts } from "./child-opts.ts";
import { type WorkConfig, loadWorkConfig, protectedPathsOf } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { MAX_BUILD_ATTEMPTS } from "./machine.ts";
import { providerWaitNote, waitOutProviderFault } from "./provider-wait.ts";
import { rereadSpec } from "./spec-for.ts";
import { CaptureBudget } from "./specify-capture.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { Outcome, Step } from "./state.ts";
import {
  type BudgetArms,
  type BudgetOpts,
  type DispatchUsageRow,
  armBudget,
  budgetFor,
  budgetSentence,
  budgetVerdictWithRows,
  readDispatched,
} from "./step-budget.ts";
import { joinNotes } from "./text-fence.ts";

export interface BuildDeps {
  exec: BuildExec;
  dispatch: BuildDispatch;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  /** The aggregate capture ceiling in bytes; absent, the production ceiling applies. */
  captureCeiling?: number;
  /** The bound on the driver's re-runs of a frozen test — the blocked report's loop
   * and the stopped build's sweep alike. A test shortens it to watch a hang. */
  blockedTimeoutMs?: number;
  /** The resumed-child seam a wasted build turn gets ONE ask through (see `askBuildReask`);
   * production is `spawnDeveloperContinuationChild`, the same seam the review fixer's wave uses. */
  continueSession?: DeveloperContinuationFn;
}

/** The `build` step. Returns `ok` | `exhausted` | `blocked`; THROWS on infrastructure. */
export async function buildOutcome(
  ctx: HandlerCtx,
  deps: BuildDeps,
  /** The run's permission stamp, threaded by the caller that owns the mode (see `buildDeps`). A
   *  continuation the step starts is stamped exactly as its parent child was — an unstamped second
   *  turn is permission-denied on the arm where the first ran free. */
  headless = false,
): Promise<Outcome> {
  const { repoRoot, issue } = ctx;

  // 1. The contract, out of the run's own record.
  const frozen = frozenFromLog(ctx.steps);

  // 2. The tree and the head it must sit at.
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
  // The spec, re-read from the forge: a build against an unread spec is fiction. The accessor,
  // because a derived run has no block on its issue and `ready` already validated its contract.
  const { spec, body: issueBody } = await rereadSpec(
    () => deps.fetchIssueBody(repoRoot, issue),
    ctx.run,
    (m) => new BuildInfraError(m),
  );
  // Rounds this run has DISPATCHED and paid for. `buildAttempts` is the authority
  // because the table bills a round on entering `build` and never on leaving it: it
  // counts dispatches, not table visits, so one child a ceiling stopped costs one
  // round and the retry loop below stops only when the budget is spent. The round
  // this visit is running is not in the count yet — the edge that enters `build`
  // bills it when the engine applies the verdict — hence the +1 below.
  const dispatchedBefore = ctx.run.counters.buildAttempts;
  // What the child's prompt and its commit subject call the round: the decided
  // `build` rows below this one — a LOG fact, so a resumed visit prints the number
  // the log says and never repeats one. The counter and the log can disagree for a
  // resumed record, and that is honest: the label counts rows, the cap below
  // counts dispatches.
  const label = ctx.steps.filter((s) => s.state === "build" && s.outcome !== undefined).length + 1;
  // 4. The builder, under the state's budget. A child that died THROWS, so
  //    the rows ride on the error to the outcome the engine writes. A
  //    child its OWN ceiling stopped is retried HERE — the table has no `build`
  //    self-edge — and its work rides forward on the commit its fold made.
  // The tree, head and contract every fold of this attempt is judged against.
  const fold = (n: number) => ({
    exec: deps.exec,
    wt,
    repoRoot,
    branch,
    headBefore,
    frozen,
    // The round the prompt and the commit subject name.
    attempt: n,
    issue,
    // The project's own protected globs, read once with the config above, so this step's two
    // folds cannot disagree about what is untouchable.
    protected: protectedPathsOf(config),
  });
  const reentry = reentryFromLog(ctx.steps);
  const added = addedByChallengeFromLog(ctx.steps);
  let stopped = budgetStopFromLog(ctx.steps);
  // The wait note of a provider fault this visit sat out, folded into the reason
  // of whichever verdict this visit records (empty joins to nothing).
  let waitedMs = 0;
  // What this visit's ceiling-stopped folds reverted, and which configured globs named no path.
  const budgetFold = budgetFoldAccumulator();
  const waitNote = () => (waitedMs > 0 ? providerWaitNote(waitedMs) : "");
  const rows: DispatchUsageRow[] = [];
  let toolUses: unknown[] = [];
  // Children this visit has put on the wire. `buildAttempts` counts rounds the
  // table DISPATCHED, and the edge that entered `build` already billed the round
  // this visit is running — so `dispatchedBefore` is what was spent BEFORE the
  // first child here, and `MAX_BUILD_ATTEMPTS - dispatchedBefore` is what is left
  // to buy. That difference is the whole rule: the loop may buy ANOTHER child only
  // while the rounds dispatched SO FAR sit under the cap, so it runs the one child
  // its own round paid for and stops the moment `dispatchedBefore + tries + 1`
  // reaches the cap. The `+1` matters — a test on `dispatchedBefore >= cap` alone
  // counts only what came before this visit, so a visit the table entered AT the
  // cap keeps buying children the run has no rounds left to pay for. A ci:red fix
  // round is exactly that shape: the table legitimately hands it `buildAttempts`
  // one past `MAX_BUILD_ATTEMPTS` (three dispatched rounds plus the fix round
  // itself, which no dispatch bought), and its ceiling-stopped child must run once,
  // fold, and leave — never retry in-step. Below the cap a budget stop DOES buy
  // another child, which is what lets a run spend its third build on work rather
  // than on a ceiling.
  const retriesAllowed = Math.max(0, MAX_BUILD_ATTEMPTS - dispatchedBefore - 1);
  // A child that did no work gets its one free re-dispatch of this visit: it
  // bought nothing, so it bills no round and advances no `tries`.
  let noWorkRetryUsed = false;
  // The builder's own fence, named once so the dispatch and the continuation cannot disagree about
  // what the resumed child may write (the fixer wave asks its seam the same question, see
  // `fixWriteFence`).
  const fence = buildWriteFence(wt, repoRoot, issue);
  // Why the first no-work child died, kept for the throw the second one may make.
  let firstNoWorkWhy: string | undefined;
  // The arms the LAST dispatch was bought with; the continuation's bound comes from them.
  let lastBudget: BudgetArms;
  // The child whose recorded turn the re-ask detector reads — the last one the dispatch loop broke
  // on. Set at the break and read only once, after the fold.
  let lastChildResult: DispatchResult | undefined;
  for (let tries = 0; ; tries++) {
    const budget = armsStepBudget(
      budgetFor(config, "build"),
      // #2660: both levers from one read of the step log.
      stepDispatchArms(ctx, (budgetFor(config, "build")?.minutes ?? 0) * 60_000, "build"),
    );
    lastBudget = budget;
    if (budget.warning !== undefined) traceWarn(`lean build #${String(issue)}: ${budget.warning}`);
    const [dispatchedChild, row] = await dispatchBuilder(deps.dispatch, {
      issue,
      spec,
      frozen,
      wt,
      repoRoot,
      attempt: label,
      testRunner: config.verify.test,
      issueBody,
      budget,
      ...(reentry === undefined ? {} : { reentry }),
      ...(added === undefined ? {} : { added }),
      ...(stopped === undefined ? {} : { budgetStop: stopped }),
    });
    rows.push(row);
    if ("noWorkCrash" in dispatchedChild) {
      if (noWorkRetryUsed)
        throw new BuildInfraError(
          `build dispatch failed: first: ${String(firstNoWorkWhy)}; then: ${dispatchedChild.why}`,
          rows,
        );
      // A child that did no work bought nothing: its row stays billed and the SAME
      // prompt goes out again on a freshly armed budget, without spending a round.
      // The second one of these throws, as any dead child did. The trace names this
      // re-dispatch and the cause the first child gave.
      traceWarn(
        `lean build #${String(issue)}: re-dispatching a child that did no work: ${dispatchedChild.why}`,
      );
      firstNoWorkWhy = dispatchedChild.why;
      noWorkRetryUsed = true;
      // The wait sits INSIDE the one free re-dispatch the child already earned —
      // it adds no counter and bills no round. A non-provider or hatch-off case
      // takes zero and re-dispatches exactly as before.
      waitedMs += await waitOutProviderFault({
        cls: dispatchedChild.cls,
        attempt: 1,
        now: ctx.now(),
        ...(ctx.run.deadlineMs === undefined ? {} : { deadlineMs: ctx.run.deadlineMs }),
        ...(budget.opts.signal === undefined ? {} : { signal: budget.opts.signal }),
      });
      tries--;
      continue;
    }
    // Past that branch only a real result or a ceiling stop is left on the pair.
    const read = readDispatched(dispatchedChild);
    if (!("stop" in read)) {
      toolUses = read.result.toolUses ?? [];
      lastChildResult = read.result;
      break;
    }
    // Its own ceiling stopped it: fold the work into this attempt's commit and
    // re-run the frozen files under ONE wall clock, so verify finds a clean tree and
    // the retry's prompt names what is still failing. The kind stays `budget`.
    // R5: a run the cap ENDS here names the dispatches too, which `handback` prints —
    // a ceiling alone cannot say the retries were spent. The bound is read the SAME
    // way the loop reads it, so the sentence the handback prints cannot disagree with
    // the children this visit was allowed to buy; and the count named includes
    // `dispatchedBefore`, because on a visit entered at or over the cap this loop ran
    // no retry at all and `tries` alone would claim a child it never bought.
    const atCap = tries >= retriesAllowed;
    const { kept, failing } = await foldStoppedBuild({
      ...fold(label),
      template: config.verify.test,
      ceiling: deps.captureCeiling,
      ...(deps.blockedTimeoutMs === undefined ? {} : { timeoutMs: deps.blockedTimeoutMs }),
    });
    budgetFold.note(kept);
    // The line the step log, handback and the retry's prompt all read (R3/R5): this visit's own
    // clauses plus the fold's account from `build-reasons.ts`, whose module holds BOTH of this
    // step's reason lists so a disclosure cannot reach one arm and miss the other.
    const verdict: Outcome = {
      ...budgetVerdictWithRows("build", read.stop, rows),
      reason: joinNotes([
        budgetSentence("build", read.stop),
        // Which ceiling ended the child, in the deadline's own words when it was the deadline.
        stopReasonClause(ctx, "build", (budgetFor(config, "build")?.minutes ?? 0) * 60_000) ?? "",
        ...(atCap ? [`after ${String(dispatchedBefore + tries + 1)} build attempts`] : []),
        failingClause(failing),
        keptClause(kept.files),
        ...budgetFold.clauses(kept),
        waitNote(),
      ]),
    };
    stopped = verdict.reason;
    if (atCap) return verdict;
  }

  // 4b. The child's own "these cannot all pass together", if it made one: a CLAIM,
  //     honoured only once the driver ran the named frozen tests on its tree and saw
  //     one come back red. An ignored report traces a line and records nothing.
  //
  //     A wasted turn is asked for its continuation FIRST, and the claim the cut-off turn
  //     filed is judged exactly as today: the seam loads no `report_blocked` companion, so
  //     the first turn's report stands and the continuation cannot file one.
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
    // No commit: `verify` never judges a tree this step cannot account for.
    return {
      kind: "blocked",
      reason: blocked.reason,
      blockedBy: blocked.blockedBy,
      dispatches: rows,
    };
  }

  // 5 + 6. Capture, reset, rewrite, commit — or ask the cut turn for one more turn first.
  const report = await normaliseBuild({
    ...fold(label),
    budget: new CaptureBudget(deps.captureCeiling),
  });
  // A turn that made NO tool call and left no change is not a builder that declined to edit: it hit
  // the output cap mid-reasoning, or answered one clean turn without acting. Both get the fixer's ONE
  // continuation, judged AFTER the fold ("no change" is the fold's answer, not a child field) and
  // before the verdict. `tries` and `noWorkRetryUsed` are untouched; the ask is one-shot by being
  // asked once here. `budgetFired` is a constant false, not a swallowed read: `dispatchBuilder`
  // consults `budget.fired(result)` on EVERY child — turns, tokens, stall and the deadline-derived
  // minutes lever — and a breach returns a BudgetStop that this loop folds and returns or retries,
  // so the single `break` is the only edge reaching here and no fired ceiling can (case (2b)).
  const noChange = report.files.length === 0;
  const wasted =
    noChange && lastChildResult !== undefined
      ? buildTurnWasWasted(lastChildResult, { budgetFired: false, noChange: true })
      : ({ wasted: false, reason: "no-final-turn" } as const);
  // `undefined` covers both the un-wasted arm and the ask's own refusals (no seam, no session path):
  // refused before a child was paid for, so nothing is billed and only the trace says why.
  const asked =
    wasted.wasted && lastChildResult !== undefined
      ? await askBuildReask(deps.continueSession, {
          child: lastChildResult,
          trigger: wasted.trigger,
          issue,
          worktree: wt,
          writeFence: fence,
          // The ask's own ceiling, clamped to what the armed budget left — the clamp lives with the
          // fixer's bound, which the step already reads.
          boundMs: continuationBoundMs(lastBudget, BUILD_REASK_BOUND_MS),
          prompt: buildReaskPrompt(issue, wasted.trigger),
          rowFor: (outcome, role) => continuationRow(outcome, role, undefined),
          // The run's stamp, from the function that decides it — not re-derived here.
          ...leanChildOpts(headless),
        })
      : undefined;
  if (asked !== undefined) {
    rows.push(asked.row);
    const again = await normaliseBuild({
      ...fold(label),
      budget: new CaptureBudget(deps.captureCeiling),
    });
    if (again.files.length > 0) return okVerdict(again, rows, waitNote);
  }
  if (!noChange) return okVerdict(report, rows, waitNote);
  return {
    kind: "exhausted",
    reason: joinNotes([
      "the developer produced no change",
      waitNote(),
      // ONE short clause, LAST, and only when the ask was spent: the head and the wait note keep
      // their bytes for every arm that never asked, which the existing literals pin.
      asked !== undefined && wasted.wasted
        ? buildReaskClause(wasted.trigger, wasted.outputTokens)
        : "",
    ]),
    dispatches: rows,
  };
}

/** The seat's fence — the root, repo and scratch the child was fenced by, so the continuation is
 *  never handed a wider one than the dispatch it resumes. */
function buildWriteFence(wt: string, repoRoot: string, issue: number): WriteFence {
  return {
    root: wt,
    repo: repoRoot,
    // `<repoRoot>/tmp/lean-<issue>` — one `..` from the worktree's parent, per scratch hygiene.
    scratch: path.join(path.dirname(wt), "..", "tmp", `lean-${String(issue)}`),
  };
}

/** The verdict for a visit whose tree holds a change: one `ok` with the fold's account. */
function okVerdict(
  report: NormaliseReport,
  rows: DispatchUsageRow[],
  waitNote: () => string,
): Outcome {
  return {
    kind: "ok",
    reason: joinNotes([
      `${String(report.files.length)} file(s) changed`,
      ...foldClauses(report),
      waitNote(),
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
        // Forwarded so the ceiling binds the child; `budgetTurns` is the same
        // ceiling the budget-progress steer counts down from. The grace rides beside the
        // bound: a bound with no grace of its own gets the configured 10 minutes, and a
        // deadline-derived bound killed a full grace later is the overrun this step is
        // bounded against. Pinned on the leaf by test-lean-step-deadline-bound-seams.ts.
        childBoundMs: o.childBoundMs,
        childBoundGraceMs: o.childBoundGraceMs,
        signal: o.signal,
        onProgress: o.onProgress,
        budgetTurns: o.budgetTurns,
        ...(o.stall === undefined ? {} : { stall: o.stall }),
        // The budget's kill goes through `killProcessTree`, which only reaches the
        // child's tool tree when the child leads its own group.
        processGroup: true,
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
    // The same resumed-child seam the review fixer's wave asks through: the build seat's cut turn is
    // the same child shape with the same roster, fence and tree.
    continueSession: spawnDeveloperContinuationChild,
  };
}
