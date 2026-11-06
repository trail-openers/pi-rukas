/**
 * lean/review — the run's gate: one adversarial pass, one six-lens pass, and
 * one fix wave between them.
 *
 * Both gates are the frozen driver's own code, called rather than copied:
 * `runAdversarialLoop` in report-only mode (it reviews and fixes nothing; this
 * step routes its verdict) and `runLensReview` for the six lenses. What is
 * lean's own is which tree they read, who fixes what they find, and when the
 * step stops. Where the bytes are and how they move is `review-git.ts` and
 * `review-tree.ts`; the shapes the two gates are called with are
 * `review-args.ts`; what the step says about its own cost is `review-step.ts`;
 * the one-wave policy it enforces is `review-waves.ts`; this file is the
 * decision procedure.
 *
 * **Both gates read a resolved commit, never a working copy.** A gate approves
 * the bytes at a commit, and the only value that cannot be dirtied underneath
 * the step between two passes is a commit sha resolved from a ref. This step
 * resolves origin's branch and hands the same value to both gates, to the
 * fixer, and to the integration — five uses of one commit cannot disagree, and
 * a working copy would give each of them a different tree. Both gates therefore
 * get a ref range they compute their own diff from rather than a string this
 * step pasted: a pasted diff is a value the reviewer cannot re-read, and a
 * range is one it can.
 *
 * **The fix runs in a disposable tree of its own** (the tree lifecycle is in
 * `review-tree.ts`, the wave in `review-git.ts`), detached at the reviewed
 * commit and destroyed at the end of the step — because the fixer must not
 * touch the tree `verify` and `publish` read. A child loose in the run's
 * worktree between two gates would leave the green verdict describing one
 * commit and the PR holding another. Detached on
 * purpose: a fixer that commits there moves no branch, so a child that committed
 * twice, amended, or reset could not corrupt what the run merges. Only the
 * integration moves anything, and only after its claims hold.
 *
 * **Two bounds, two jobs.** The shape of the wave is a module fact, not an
 * operator knob: `REVIEW_CHILD_BUDGET` in `review-waves.ts` states what one step
 * may buy, and `budgets.review` in `.pi/work.json` is the money, armed on every
 * child the step dispatches through the same `armBudget` the other three
 * dispatching steps use. They are never divided into each other. Deriving a cap
 * from the turn budget (`turns / TURNS_PER_ROUND`) once shipped a default budget
 * of **one round**, and one round can fix but can never re-review — so the step
 * certified a head no gate had looked at since its own fixer moved it. The
 * budget stays fully live and stays the stop condition the operator owns: it is
 * armed on every child through `armBudget`. A child that spends it is NOT a
 * routed verdict the way `build`/`challenge`/`specify` route theirs — this step
 * has no `budget` arrow to route on, so the stop throws with the rows it paid for
 * (see below for why the two shapes differ).
 *
 * **What a gate must say to buy a fixer.** A blocking row or a CRITICAL verdict,
 * never a verdict name. The adversarial gate's doctrine calls `CRITICAL_ISSUES_FOUND`
 * the blocking one and `ISSUES_FOUND`/`MINOR_OBSERVATIONS` explicitly non-blocking;
 * the six-lens layer reserves its CRITICAL verdict the same way and reaches
 * `ISSUES_FOUND` for anything at or above the project's bar (`computeVerdict`), so the
 * lens arm is judged on its rows (`lensBlocks`) rather than on that name. The step
 * therefore ENDS clean only when neither gate produced a blocking row or record — no
 * fixer, no re-review, no second gate pass — and its findings are disclosed by the
 * review layer's own residual post, which is where non-blocking findings have always
 * gone. The step pays for a fix only where the reviewing layer itself said the branch
 * must not proceed.
 *
 * **What ends the step.** Both gates clean ends it, on one of two kinds that
 * differ only in what the step did to the branch: `done` when no fix wave ran
 * and the run goes to `ci`, or `fixed` when the wave pushed commits and the run
 * must re-verify the head it now has. Which of the two is read from the durable
 * log, not from a variable — see `fixedFromLog` in `review-log.ts` for why a
 * closure cannot answer that question for a resumed attempt.
 *
 * **One wave, not a loop.** One full review (the adversarial pass and the six
 * lenses); if it blocks, ONE fixer given every blocking finding at once; then
 * ONE re-review whose range is the fix, which decides each blocking finding
 * ADDRESSED or NOT ADDRESSED and whether the fix itself introduced a CRITICAL.
 * There is no second wave and no round constant — the machinery that bounded a
 * repeating loop (the round cap, the stagnation tie-breaker, the per-round tree
 * naming) is deleted, not left behind as insurance. What a wave does not clear
 * ends the step with a named cause, because a gate that has said the same thing
 * twice across a fix is not a gate another paid round will satisfy. The
 * measurements behind that policy are in `review-waves.ts`.
 *
 * Anything else THROWS: a gate that produced no verdict, a head that moved or
 * vanished mid-wave, a fix wave that changed nothing, a blocking finding the
 * wave did not address, a CRITICAL the fix introduced, a fixer that rewrote the
 * frozen contract, an integration that could not be proven — and a child the
 * operator's budget stopped. A throw is the engine's infrastructure path — the
 * run hands back at exit 10 with the cause named, rather than carrying an
 * unreviewed head forward on a pass it did not earn. A gate that did not run is
 * never a gate that passed.
 *
 * **A budget stop is a throw here, not a routed kind — which is the opposite of
 * `specify`, `build` and `challenge`.** Those three have a table arrow for
 * `budget` and decide with it: `specify`/`build` hand back, `challenge` continues
 * to `verify` (#1883). `review` has two kinds and neither is a stop: anything that
 * is not both gates clearing must not route onward. So all three reads of a
 * stopped child — the adversarial reviewer, and the fixer on each of the two fix
 * arms — throw {@link ReviewInfraError} whose message is the shared
 * `budgetSentence` and whose rows are the children the step bought. Returned as
 * `{kind: "budget"}` instead it reaches `settle` with no arrow for the pair and
 * the run's cause reads `no transition for review + "budget"`: a broken-looking
 * table where the truth is a stopped child.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import { isCarried } from "../lens-review-types.ts";
import type { runLensReview } from "../lens-review.ts";
import { trace, traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchSpec } from "../types.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { frozenFromLog } from "./build.ts";
import type { HandlerCtx } from "./engine.ts";
import {
  RE_REVIEW_LANE,
  type ReviewBoundRecord,
  type StepStop,
  reviewBoundComment,
  reviewBoundRecord,
  stepBound,
  stepStopOf,
} from "./review-bound.ts";
import { assertReviewEntry } from "./review-entry.ts";
import { adversarialGate, lensGate } from "./review-gates.ts";
import { fixRound, reviewedHead } from "./review-git.ts";
import {
  fixRunId,
  fixRunIdFromLog,
  fixedFromLog,
  prNumberFromLog,
  reviewAttemptFromLog,
} from "./review-log.ts";
import { cleanPass, disclosureNote } from "./review-pass.ts";
import { assertFixAdvanced } from "./review-progress.ts";
import { assertRan, assertRangedOverTheFix } from "./review-round-guards.ts";
import { budgetStopped } from "./review-step.ts";
import { closeFixTrees } from "./review-tree.ts";
import {
  CAUSE_NEW_CRITICAL,
  CAUSE_NOT_ADDRESSED,
  CAUSE_NO_CHANGE,
  LENSES_PER_PASS,
  LENS_DID_NOT_RUN,
  atOrAboveBar,
  lensBlocks,
  renderFinding,
  renderRows,
} from "./review-waves.ts";
import { specifyBranch } from "./specify-tree.ts";
// The error lives in a leaf module so the extracted predicates can throw it without
// importing this handler back. Re-exported so every existing `import { ... }
// from "./review.ts"` — including the smoke fixtures' — keeps working.
export { ReviewInfraError } from "./review-errors.ts";
// The shapes the step's participants compile against live in `review-args.ts`:
// re-exported so every existing `import { ... } from "./review.ts"` — including
// the smoke fixtures' — keeps working.
export type {
  AdversarialArgs,
  FixRunId,
  LensArgs,
  LensRound,
  ReviewDeps,
} from "./review-args.ts";
// The step's own wall clock: the record, its shape and the reserve constant are
// re-exported for the readers of the step's outcome (the validator, the headless
// projection, the smoke suites) without an import that reaches into the step.
export {
  REVIEW_DEADLINE_RESERVE_MS,
  type ReviewBoundRecord,
  type StepBoundLimit,
  type StepStop,
  reviewBoundComment,
  reviewBoundRecord,
  stepBound,
  stepBoundSentence,
  stepStopOf,
} from "./review-bound.ts";
// The one-wave policy — the child budget, the blocking bar and the named handback
// causes — lives in `review-waves.ts`; re-exported for the same reason as the
// argument shapes.
export {
  CAUSE_NEW_CRITICAL,
  CAUSE_NO_CHANGE,
  CAUSE_NOT_ADDRESSED,
  LENS_DID_NOT_RUN,
  PASS_ROWS,
  REVIEW_CHILD_BUDGET,
  REVIEW_PASSES,
} from "./review-waves.ts";
import type { LensRound, ReviewDeps, ReviewWave } from "./review-args.ts";
import { ReviewInfraError } from "./review-errors.ts";
import type { Outcome } from "./state.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import {
  armBudget,
  budgetFor,
  lastChildMs,
  stepFired,
} from "./step-budget.ts";

/** The fixer's wall clock, the shape the other steps pass as `childBoundMs`. */
export const FIX_BOUND_MS = 20 * 60_000;

/**
 * The lens names a pass was supposed to judge and did not.
 *
 * The names come from the round's own per-child records — the skill roster's
 * names, not a literal this step invented — and the count is the difference
 * between the roster the step buys (`LENSES_PER_PASS`) and the children that
 * actually ran. A round that named nothing at all reports the count alone, which
 * is the honest answer for a round nobody could read names from.
 */
export function unjudgedLenses(round: LensRound | undefined): string[] {
  const ran = round?.lenses.length ?? 0;
  const missing = LENSES_PER_PASS - ran;
  if (missing <= 0) return [];
  const named = (round?.lenses ?? [])
    .map((lens) => lens.lens)
    .filter((name) => typeof name === "string" && name !== "");
  if (named.length === 0) return [`six-lens round (${String(missing)} lenses unrun)`];
  return named;
}

/**
 * The `review` step. Returns one of the step's two pass kinds — `done` or
 * `fixed` (see `passKind` in `review-step.ts` for what the two differ in); a
 * budget stop is NOT returned, it throws; and so does anything else.
 */
export async function reviewOutcome(ctx: HandlerCtx, deps: ReviewDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  const branch = specifyBranch(ctx.run.branch, issue);
  const base = ctx.run.baseSha;
  // **THE ENTRY GATE, BEFORE ANYTHING IS PAID FOR OR TOUCHED.** The four refusals
  // and the reason their placement is the substance of the change live in
  // `review-entry.ts`, whose whole contract is "refuse a run this step must not
  // start"; the ordering mutation that proves the guarantee is stated at the push
  // site in `review-git.ts`.
  await assertReviewEntry({ repoRoot, branch, base });

  // The contract, the config and the issue, all read before any child is paid:
  // a step that discovered its spec was unreadable after two passes of review
  // had spent those passes for nothing.
  const frozen = frozenFromLog(ctx.steps);
  /**
   * The PR number of the PR this run's `publish` opened, from its recorded URL —
   * or undefined when no step has recorded one. Read from the log rather than a
   * closure so a resumed run has it too, and derived rather than stored: `publish`
   * records the URL and this is its tail (see `prNumberFromLog`).
   */
  const pr = prNumberFromLog(ctx.steps);
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new ReviewInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const issueBody = await deps.fetchIssueBody(repoRoot, issue).catch((err: unknown) => {
    throw new ReviewInfraError(`could not read the issue: ${(err as Error).message}`);
  });
  // The blocking bar, resolved ONCE for the whole step at the run's base commit,
  // beside the config and the issue and for the same reason: it is a fact the
  // step needs before it pays for a pass, and a step that discovered its bar was
  // unreadable after a review would have spent that review at the wrong one.
  // Never per pass — see `ReviewDeps.reviewThreshold`.
  const threshold = await deps.reviewThreshold(repoRoot, base).catch((err: unknown) => {
    throw new ReviewInfraError(
      `could not resolve the project's review threshold: ${(err as Error).message}`,
    );
  });

  // The step's disposable trees are named once per attempt, so a resumed run
  // re-enters the paths its crashed self left (see `fixRunId`). There is one wave,
  // so one name serves; the value still comes from the log rather than a
  // closure because the attempt that pushed may be the one that crashed.
  const runId = fixRunIdFromLog(ctx.steps) ?? fixRunId(ctx.now);
  // The step's budget, armed the way `build`, `challenge` and `specify` arm
  // theirs. `armBudget` turns `budgets.review` into the three levers a child
  // actually gets — `minutes`→`childBoundMs`, `turns`/`tokens`→ an abort off the
  // progress stream — and `fired` reads back which one ended a child. Before
  // this the step read `budgets.review.turns` for one division and armed
  // NOTHING, so a review ran its reviewer, its six lenses and its fixer under
  // the generic child bound while the operator's ceilings sat unread: the pilot
  // that reported "minutes budget 20 exceeded (used 31)" beside a child that ran
  // 1,800,180 ms is that gap. The other steps honour this budget; deleting the
  // fields instead would have deleted the operator's only lever over what a
  // review costs.
  const budget = armBudget(budgetFor(config, "review"));
  if (budget.warning !== undefined) traceWarn(`lean review #${String(issue)}: ${budget.warning}`);
  // **The step's OWN clock, beside the per-child arms and for a different job.**
  // `armBudget` bounds one child at a time; this bounds the step. Its minutes
  // come from the same `budgets.review` row the children read, and its deadline
  // lever is the handoff allowance plus the review reserve — the time publish,
  // ci and land still need, which the engine's between-steps check cannot protect
  // because it never looks while a step runs. See `review-bound.ts`.
  const reviewMinutes = budgetFor(config, "review")?.minutes ?? 0;
  // One disclosure, filled by whichever arm the clock closed in, posted once at
  // the end of the step: one comment on the PR, not one per stop point.
  let boundRecord: ReviewBoundRecord | undefined;
  /** The step's clock at this instant; the caller decides what a stop means. */
  const clock = (): StepStop | undefined =>
    stepStopOf(stepBound(ctx, reviewMinutes, ctx.now(), ctx.stepStartedAt));
  /**
   * Record a stop the caller has just decided how to route, and say it out loud.
   *
   * `traceWarn`, not `trace`: the step's two boundary lines are debug-gated, and
   * the run that produced the field failure was a fire-and-forget run with no
   * debug on — a bound visible only under `PI_ENSEMBLE_DEBUG` is visible in
   * exactly the runs that do not need it.
   */
  const noteStop = (stop: StepStop, wave: ReviewWave, lanes: string[]): void => {
    boundRecord = reviewBoundRecord(stop, wave, lanes);
    traceWarn(`lean review #${String(issue)}: ${stop.reason}`);
  };
  /**
   * The handback a step-clock stop takes, with the stop's numbers in the trio the
   * shared `budgetSentence` renders. The step is throwing where its children's
   * stops throw too — the clock that closed is named in the disclosure, and R8
   * keeps a per-child stop's own cause line ahead of this one wherever both hold.
   */
  const stepStopped = (stop: StepStop): ReviewInfraError =>
    budgetStopped(stepFired(stop), rows);
  /**
   * The pass the step returns, with the step's own stop on it when there was one
   * (and EXACTLY the shape it returns today when there was not — no key at all,
   * which is what keeps every existing review case green).
   *
   * `stopAfterFix` is its one routed arm: a stop after the fixer pushed routes
   * `fixed`, back through `verify`, because origin holds a head the fix moved and
   * `ci` refuses to certify one the gate never read after it (R2).
   */
  const passWithBound = (pass: Outcome): Outcome =>
    boundRecord === undefined ? pass : { ...pass, reviewBound: boundRecord };

  // `rows` accumulates across the WHOLE step, not one pass: the handback must say
  // what every child cost, including the one that failed. Nothing re-derives it
  // per pass — a total rebuilt for the re-review reports a two-pass run to the
  // operator as a one-pass one.
  const rows: DispatchUsageRow[] = [];
  let head = await reviewedHead(deps, repoRoot, branch, rows);
  // This attempt's number, from the log the engine resumes off — see
  // `reviewAttemptFromLog`. It is part of the fix tree's name, so it is read once
  // here rather than derived per pass.
  const attempt = reviewAttemptFromLog(ctx.steps);

  try {
    // ── pass 1: the full review — the adversarial gate, then the six lenses ──
    // R1: a stop anywhere in pass 1 hands back. Nothing has been reviewed yet, so
    // there is no verdict to proceed on and no head to certify; the step records
    // the lanes it did not judge and throws, which is the engine's handback path.
    const preGate = clock();
    if (preGate !== undefined) {
      noteStop(preGate, "full", unjudgedLenses(undefined));
      throw stepStopped(preGate);
    }
    const gate = await adversarialGate(deps, ctx, {
      base,
      head,
      branch,
      issueBody,
      wave: "full",
      rows,
      budget,
    });
    // The operator's ceiling stopping this step is read BEFORE the gate's own
    // infra throw could mistake a stopped reviewer for "no verdict at all", and
    // it THROWS: both arrows out of `review` are clean passes, so a stopped
    // child has no route and must not be mistaken for one (see this file's
    // header for why this step throws where the other three route).
    if (gate.stop !== undefined) throw budgetStopped(gate.stop, rows);
    const preLens = clock();
    if (preLens !== undefined) {
      noteStop(preLens, "full", unjudgedLenses(undefined));
      throw stepStopped(preLens);
    }
    // Findings the adversarial pass passed on WITHOUT blocking travel to the
    // lenses, which are told to judge them; the lens round's `carried` parameter
    // exists for this one value and nothing else. That is the non-blocking reading
    // and it is deliberately the only one taken here.
    const carried = gate.findings;
    // Whether the ADVERSARIAL gate is what bought this wave, decided by the one
    // thing that says so — `gate.blocking`, the trailing record read by
    // `blockingRecord` — and never by `carried !== ""`. A non-blocking gate still
    // has findings (that is what `carried` above is for), and deriving the gate's
    // contribution from their presence would credit a disclosure with buying a
    // fixer: the brief would name "adversarial pass" for findings the loop itself
    // declined to stop the run for, the tree's arm would say `a` for a pass the
    // six-lens round alone blocked on, and `fixTreeName`'s documented meaning of
    // the arm would stop matching the step.
    const fromGate = gate.blocking;

    const review = await lensGate(deps, ctx, {
      base,
      branch,
      wave: "full",
      issueBody,
      pr,
      carried,
      rows,
      budget,
      threshold,
    });
    assertRan(review, rows);
    // A round that did not complete is refused BEFORE either verdict is read, in
    // both directions: it is not a pass to walk on, and it is not a verdict to fix
    // against. Checking the clean bar first would let `REVIEW_INCOMPLETE` fall
    // through the non-blocking branch into a `done` — a head nobody reviewed
    // certified, on the same round that used to throw.
    if (LENS_DID_NOT_RUN.includes(review.verdict))
      throw new ReviewInfraError(
        `the six-lens review did not complete (${review.verdict}${review.note === undefined ? "" : `; disclosure: ${review.note}`}) — an incomplete round is not a pass to fix against`,
        rows,
      );
    if (!lensBlocks(review, threshold) && !gate.blocking) {
      // Neither gate blocked, so there is no wave and no re-review: the run goes
      // on as it always did. Both halves of the bar are the reviewing layers' own:
      // `gate.blocking` is the loop's trailing record read by `blockingRecord`, and
      // `lensBlocks` is the layer's CRITICAL verdict or a reported row at the
      // project's bar — a reviewer that reported findings below the bar without
      // stopping the run has them carried to the lenses above and disclosed by the
      // review layer, and the step pays nobody to fix what the reviewing layer itself
      // declined to block on.
      return passWithBound(cleanPass(review, rows, fixedFromLog(ctx.steps)));
    }

    // Between the first round and the fixer: the wave has not started, so a stop
    // here is still a pass-1 stop (R1) — nothing of the fix has been reviewed and
    // the branch is unchanged, which is the handback case, not the proceed case.
    const preFix = clock();
    if (preFix !== undefined) {
      noteStop(preFix, "full", unjudgedLenses(review));
      throw stepStopped(preFix);
    }

    // ── the one fix wave: a single fixer, given every blocking finding ────────
    // Reached only when something blocked: the lens round's CRITICAL verdict, or
    // the adversarial record `blockingRecord` called blocking. Both gates'
    // outstanding findings then go in one brief — a fixer handed half the findings
    // would be re-run by a second wave to be told the rest, and there is no second
    // wave: the wave is what the step buys, once.
    //
    // `fromGate` is the ONE value that says which gate produced the findings, and
    // every derived part of the fixer's brief comes off it: the finding text, the
    // gate name the brief prints, and the tree's arm. Three independent readings
    // of "did the adversarial pass contribute?" is how they start disagreeing —
    // the arm and the brief then describe different gates, and `fixTreeName`'s doc
    // ('a' is a pass the six-lens round approved and only the adversarial gate left
    // findings on) stops matching what the step actually does.
    const blocking = review.findings;
    const findings = fromGate ? [carried, blocking].join("\n\n") : blocking;
    const gateName = fromGate
      ? `adversarial pass and six-lens review (${review.verdict})`
      : `six-lens review (${review.verdict})`;
    const fix = await fixRound(deps, ctx, {
      head: review.head,
      frozen,
      findings,
      issueBody,
      gate: gateName,
      wave: "full",
      // The arm the tree's name carries: "a" when the findings came from the
      // adversarial gate, "l" when the six-lens round raised them. See `fromGate`.
      arm: fromGate ? "a" : "l",
      attempt,
      runId,
      rows,
      budget,
    });
    if (fix.stop !== undefined) throw budgetStopped(fix.stop, rows);
    // The range the re-review reads is bounded BELOW by the head the fix wave
    // started from, and that value is what the wave itself reported — never a
    // fresh read of origin, which by now may hold somebody else's push. Held
    // before the head moves, because after the move the pre-fix head is not
    // recoverable from anything but this binding.
    const preFixHead = review.head;
    head = await assertFixAdvanced(review.head, fix.head, rows);

    // R2: the fixer pushed, so the head origin holds is one nobody has re-judged.
    // A stop here is neither a handback (the fix is already on the branch, and
    // throwing would strand it with the run handing back over a moved head) nor a
    // `done` (`ci` would certify a head its gate never read after a fix). It is
    // `fixed`: back through `verify`, with the unjudged lanes disclosed.
    const preReReview = clock();
    if (preReReview !== undefined) {
      noteStop(preReReview, "fix", [RE_REVIEW_LANE, ...unjudgedLenses(review)]);
      return passWithBound(cleanPass(review, rows, true));
    }

    // ── pass 2: the re-review, scoped to the fix range and nothing else ───────
    const reReview = await lensGate(deps, ctx, {
      base,
      branch,
      wave: "fix",
      issueBody,
      pr,
      carried,
      since: preFixHead,
      rows,
      budget,
      threshold,
    });
    assertRan(reReview, rows);
    if (LENS_DID_NOT_RUN.includes(reReview.verdict))
      throw new ReviewInfraError(
        `the re-review of the fix did not complete (${reReview.verdict}${reReview.note === undefined ? "" : `; disclosure: ${reReview.note}`}) — an incomplete round is not evidence that the fix answered anything`,
        rows,
      );
    // THE RE-REVIEW MUST PROVE WHICH RANGE IT JUDGED — the stamp's presence and
    // both of its bounds are preconditions on the round's evidence, so they are the
    // guards' question, not the step's (see `assertRangedOverTheFix`).
    await assertRangedOverTheFix(deps, repoRoot, reReview, { since: preFixHead, head }, rows);
    // The adversarial gate's second pass runs AFTER the delta round it judges:
    // its range is the fix's own `since..head`, the same range the lenses were
    // handed. Running it before the round would have it judge a head whose
    // verdict the step has not yet read, and a re-review the step already knows
    // it will refuse would have bought the reviewer for nothing.
    const reGate = await adversarialGate(deps, ctx, {
      base,
      head,
      branch,
      issueBody,
      wave: "fix",
      // The CRITICAL bar the second pass judges against: the rows the fix range
      // itself is allowed to introduce. Read off the same list the lenses were
      // given, not re-derived from prose.
      blockingFindings: blocking,
      rows,
      budget,
    });
    if (reGate.stop !== undefined) throw budgetStopped(reGate.stop, rows);
    // Past the stop above the pass reached a verdict, so both prose fields it
    // carries are present — read once, so the three uses below cannot disagree.
    const reGateText = reGate.findings ?? "";
    const reGateOpen = reGate.open === true;
    // Both the re-review round and the second adversarial pass have now run: the
    // wave is complete, every lane has been judged once, and a stop at this last
    // point can only be a disclosure. The step's own two kinds say what happens
    // next (`fixed` when the wave moved the branch, `done` when nothing did) and
    // `machine.ts` sets `reviewDone` for both, so a head with only re-review lanes
    // unjudged proceeds — disclosed — exactly as R7 states.

    // THE RE-REVIEW'S DECISION, read off the review layer's own record and
    // nothing else: its verdict, and its rows. The layer has already decided each
    // row's fate — `rowFate` refuses to resolve an open row whose cited code is
    // unchanged, so a row that reaches `reported` carrying `carried` IS the
    // layer's statement that the fix did not answer it, and everything else the
    // layer concluded lives in its own `resolved`/advisory sets and residual post.
    // The step used to keep a per-finding fate table beside that (`classifyFates`,
    // `findingKey`, an open-row set and title matching against the resolve
    // notices): a second source of truth for a judgement the layer owns, and each
    // of its rules — a title-only resolve match, a re-reported row read as
    // addressed — was a HIGH finding away from the layer's own answer. One source
    // of truth is the cheaper invariant, so the three readings below are all the
    // step does: the layer's CRITICAL verdict, a carried row at the project's bar
    // or above, and the gate's own CRITICAL record.
    //
    // The carried scan reads BOTH row sets the layer hands over. `reported` is the
    // BLOCKING half, and `advisory` holds what `splitAdvisory` moved out of it — so
    // a carried HIGH whose cited line fell outside the PR's changed lines is not in
    // `reported` at all, and a check that read only that list would call the wave
    // cleared on a row the layer still holds open. That is not the step discounting
    // a finding (the layer's own range rule did) — it is the step letting the
    // layer's discount decide a question the layer never put to it, since the
    // advisory tier is excluded from the verdict, the counts and `hasCritical`. A
    // carried row is the layer saying "not addressed", whatever tier it sits in.
    const unresolved = [...reReview.reported, ...reReview.advisory].filter(
      (f) => isCarried(f) && atOrAboveBar(f, threshold),
    );
    // The gate's own words join the refusal only when that pass BLOCKED — the
    // re-gate's CRITICAL record is a demand on the fix, and its wording survives
    // nowhere else (lean has no PR body). A non-blocking pass is disclosure, and
    // its prose never renders as a demand.
    const gateRow =
      reGate.blocking === true && reGateText.trim() !== ""
        ? [`[HIGH] ADVERSARIAL ${neutraliseEvidence(reGateText).slice(0, 300)}`]
        : [];
    if (unresolved.length > 0 || gateRow.length > 0)
      throw new ReviewInfraError(
        `${CAUSE_NOT_ADDRESSED}: ${renderRows([...unresolved.map(renderFinding), ...gateRow])} — the fix wave ran, the re-review carried these blocking rows against the fixed head, and a second wave is not what a gate that repeated itself needs. Origin is at the fixer's head: the fix IS pushed. Fix range ${preFixHead.slice(0, 12)}..${head.slice(0, 12)}.`,
        rows,
      );
    if (reReview.verdict === "CRITICAL_ISSUES_FOUND")
      throw new ReviewInfraError(
        `${CAUSE_NEW_CRITICAL}: the re-review of the fix range refused the fixed head (${reReview.verdict}) — ${renderRows(reReview.reported.map(renderFinding))}. Origin is at the fixer's head: the fix IS pushed. Fix range ${preFixHead.slice(0, 12)}..${head.slice(0, 12)}.`,
        rows,
      );
    // A CRITICAL the report-only adversarial pass found in the fix range that the
    // lenses did not name is still a CRITICAL the fix introduced, and the pass's
    // own record is what says so: only a CRITICAL status blocks (the policy is
    // that only a new CRITICAL blocks), read by `blockingRecord` off the trailing
    // record. A non-blocking pass (MINOR_OBSERVATIONS, ISSUES_FOUND, or the
    // findings it carried onward) is disclosed and never ends the wave.
    if (reGateText !== "" && reGate.blocking === true)
      throw new ReviewInfraError(
        `${CAUSE_NEW_CRITICAL}: the adversarial pass on the fix range reported a CRITICAL — ${reGateText.slice(0, 500)}. Origin is at the fixer's head: the fix IS pushed. Fix range ${preFixHead.slice(0, 12)}..${head.slice(0, 12)}.`,
        rows,
      );
    // Nothing carried and no CRITICAL anywhere: the wave cleared. What the
    // re-review disclosed, and any non-blocking word from the gate, is stated here,
    // in the reason the operator reads, as well as by the review layer's own
    // residual post. A non-blocking gate pass has no other consumer in this step:
    // lean has no PR body to hand it to (see `openFromPass`), so its count and its
    // text are put on the outcome rather than dropped — and both are neutralised
    // and bounded by `disclosureNote` on the way there. It is never a reason to buy
    // another wave.
    //
    // The count is the rows this step can say were DISCLOSED, which is not
    // `reported.length`: a row that was carried is one the layer said is still
    // open, and the arm above only refuses it at the blocking bar, so a carried
    // row below the bar does reach here — reported by a round the step is calling
    // clean, and disclosed by the layer's residual post under its carried heading.
    // `reported` also excludes the rows `splitAdvisory` moved out of it, and those
    // are the layer's to account for, in its own post. `atOrAboveBar` is the same
    // predicate the wave reads, so the two arms cannot disagree about which
    // rows blocked: what is neither carried nor blocking is disclosed.
    return passWithBound(
      cleanPass(
        reReview,
        rows,
        true,
        disclosureNote(
          reReview.reported.filter((f) => !isCarried(f) && !atOrAboveBar(f, threshold)).length,
          reGateOpen ? reGateText : "",
        ),
      ),
    );
  } finally {
    // One comment, whatever arm the clock closed in: `publish` ran before this
    // step, so the PR body cannot carry the disclosure and this is the only
    // surface a person reading the PR will see. A failed post never changes the
    // verdict — the record and the warn line already carry the stop, and a review
    // step that could reach the forge is not the reason a run ends.
    if (boundRecord !== undefined && pr !== undefined && deps.prComment !== undefined) {
      await deps
        .prComment(repoRoot, pr, reviewBoundComment(boundRecord))
        .catch((err: unknown) =>
          traceWarn(
            `lean review #${String(issue)}: could not post the unreviewed-lanes disclosure: ${(err as Error)?.message ?? String(err)}`,
          ),
        );
    }
    // Scoped to THIS attempt's trees (issue, attempt, epoch) — see `closeFixTrees`.
    // An unscoped `-fix-` match tore down a concurrent attempt's live tree, which
    // is the case `test-lean-review-tree.ts` (w) now drives.
    await closeFixTrees(deps, ctx, attempt, runId);
  }
}
