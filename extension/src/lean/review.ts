/**
 * lean/review — the run's gate: the adversarial loop, the six-lens pass, and a
 * bounded number of fix rounds between them.
 *
 * Both gates are the frozen driver's own code, called rather than copied:
 * `runAdversarialLoop` in report-only mode (it reviews and fixes nothing; this
 * step routes its verdict) and `runLensReview` for the six lenses. What is
 * lean's own is which tree they read, who fixes what they find, and when the
 * loop stops. Where the bytes are and how they move is `review-git.ts` and
 * `review-tree.ts`; this file is the decision procedure.
 *
 * **Both gates read a resolved commit, never a working copy.** A gate approves
 * the bytes at a commit, and the only value that cannot be dirtied underneath
 * the step between two rounds is a commit sha resolved from a ref. This step
 * resolves origin's branch once per round and hands the same value to both
 * gates, to the fixer, and to the integration — five uses of one commit cannot
 * disagree, and a working copy would give each of them a different tree. Both
 * gates therefore get a ref range they compute their own diff from rather than
 * a string this step pasted: a pasted diff is a value the reviewer cannot
 * re-read, and a range is one it can.
 *
 * **The fix runs in a disposable tree of its own** (the tree lifecycle is in
 * `review-tree.ts`, the round in `review-git.ts`), detached at the reviewed
 * commit and destroyed at the end of the round — because the fixer must not
 * touch the tree `verify` and `publish` read. A child loose in the run's
 * worktree between two gates would leave the green verdict describing one
 * commit and the PR holding another. Detached on
 * purpose: a fixer that commits there moves no branch, so a child that committed
 * twice, amended, or reset could not corrupt what the run merges. Only the
 * integration moves anything, and only after its claims hold.
 *
 * **Two bounds, two jobs** (see `MAX_REVIEW_ROUNDS` for the one statement of
 * how they interact). The round count is a module constant; `budgets.review`
 * in `.pi/work.json` is the money, armed on every child the step dispatches
 * through the same `armBudget` the other three dispatching steps use.
 *
 * **What ends the step.** Both gates clean is `done`, and the run goes to `ci`.
 * Anything else THROWS: findings still open at the bound, a gate that produced
 * no verdict, a head that moved or vanished mid-round, a fix round that changed
 * nothing, a fixer that rewrote the frozen contract, an integration that could
 * not be proven. A throw is the engine's infrastructure path — the run hands
 * back at exit 10 with the cause named, rather than carrying an unreviewed head
 * forward on a `done` it did not earn. A gate that did not run is never a gate
 * that passed.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import type { LensReviewSummary, Verdict } from "../lens-review-format.ts";
import type { Finding, LensRunResult } from "../lens-review-types.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchSpec, DispatchUsage } from "../types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { ExecFn } from "../worktree.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import type { BuildDispatch } from "./build-types.ts";
import { frozenFromLog } from "./build.ts";
import type { WorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { adversarialGate, lensGate } from "./review-gates.ts";
import { fixRound, reviewedHead } from "./review-git.ts";
import { fixRunId, fixRunIdFromLog, prNumberFromLog, reviewAttemptFromLog } from "./review-log.ts";
import { assertFixAdvanced, stagnantAgainstFix } from "./review-progress.ts";
import { closeFixTrees } from "./review-tree.ts";
import { specifyBranch } from "./specify-tree.ts";
import { DISPATCHES_MAX_ROWS } from "./state-outcome.ts";
// The error lives in a leaf module so the extracted predicates can throw it without
// importing this handler back. Re-exported so every existing `import { ... }
// from "./review.ts"` — including the smoke fixtures' — keeps working.
export { ReviewInfraError } from "./review-errors.ts";
import { ReviewInfraError } from "./review-errors.ts";
import type { Outcome } from "./state.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow, FixRunId } from "./step-budget.ts";
import { armBudget, budgetFor, budgetVerdictWithRows } from "./step-budget.ts";

/** The step's own throw: the run hands back, with this sentence as its cause. */

/** The state this step records under, for its budget verdict and its cause lines. */
const STEP_NAME = "review";

/**
 * How many fix rounds this step will pay for. A module constant, not an
 * operator knob: the only lean knob stays whether lean may merge.
 *
 * **How this constant and `budgets.review` interact — the one place it is
 * stated.** The constant bounds the ROUNDS (reviewer + six lenses + fixer), and
 * the budget bounds the MONEY. They are never divided into each other. Deriving
 * the round cap from the turn budget (`turns / TURNS_PER_ROUND`) shipped a
 * default 150-turn budget a `max(1, 150/300)` = **one round**, and one round can
 * fix but can never re-review — so the step certified a head no gate had looked
 * at since its own fixer moved it. That is the defect this constant closes. The
 * budget stays fully live and stays the stop condition the operator owns: it is
 * armed on every child through `armBudget`, and a child that spends it returns a
 * routed `budget` verdict (`{kind: "budget", limit, value, used}`) rather than a
 * clean round, exactly as `build`/`challenge`/`specify` route theirs.
 */
export const MAX_REVIEW_ROUNDS = 3;

/**
 * What this step may never "fix" its way past.
 *
 * A lens round that did not complete reviewed nothing, so its verdict is not
 * evidence to fix against: an empty round whose fixer then changed nothing would
 * read as a resolution and let the run merge unreviewed. The round-cap verdicts
 * are another component's budget refusing this run, which a fix round cannot
 * answer — the operator named that budget, and only they can lift it.
 *
 * Typed against the review layer's own `Verdict` union: a `string[]` compared
 * against a widened `verdict: string` lets a renamed verdict silently stop
 * matching, and the round it was meant to refuse would then be fixed against.
 */
const NO_FIX_VERDICTS: readonly Verdict[] = [
  "REVIEW_INCOMPLETE",
  "ROUND_CAP_REACHED",
  "REVIEW_INCOMPLETE_STREAK",
];

/** The fixer's wall clock, the shape the other steps pass as `childBoundMs`. */
export const FIX_BOUND_MS = 20 * 60_000;

/**
 * What one six-lens round answered, as the step reads it.
 *
 * `verdict`/`usage`/`note`/`noReview` are the review layer's own summary fields
 * rather than a hand-restated copy: `Pick<LensReviewSummary, ...>` means the
 * compiler refuses this type the moment the layer renames or retypes one of
 * them, which is exactly when a hand-written copy would have quietly kept
 * reading `undefined`.
 */
export type LensRound = Pick<LensReviewSummary, "verdict" | "usage" | "note" | "noReview"> & {
  /** The round's findings as the text a fixer is handed — one line each. */
  findings: string;
  /**
   * One record per lens child that ran, for the step's cost rows (see
   * `lensRows`). Carried rather than folded here because the fold lives with
   * the other cost rows in `step-budget.ts`, next to `dispatchUsageRow`.
   */
  lenses: LensRunResult[];
};

/** What the step hands one round of the adversarial gate. */
export interface AdversarialArgs {
  base: string;
  head: string;
  branch: string;
  cwd: string;
  issue: number;
  issueBody: string;
  round: number;
  headless: boolean;
  /** The step's armed budget: the child's bound, its abort, its progress hook. */
  budget: BudgetArms;
}

/** What the step hands one round of the six-lens pass. */
export interface LensArgs {
  base: string;
  head: string;
  branch: string;
  cwd: string;
  round: number;
  /**
   * The run's PR number, when this run opened one. `publish` records the PR's
   * URL and the number is the tail of it; without it the review layer has to
   * ask the forge which PR belongs to the branch on every ISSUES_FOUND round
   * (a `gh pr list` per round for an answer this run already holds), and the
   * round's residual-findings disclosure is keyed on whatever that lookup
   * picked.
   */
  pr: number | undefined;
  /** The context lines this step composes (see `lensContext` in `review-deps.ts`). */
  context: string;
  /** Post-change prose and the deterministic claim scan, read from the branch ref. */
  evidence: string | undefined;
  extraFindings: Finding[];
  /** The headless trust stamp this run's children carry. */
  headless: boolean;
  /** The step's armed budget, threaded to the lens children. */
  budget: BudgetArms;
}

/**
 * The fixer's tree identity: the epoch milliseconds its name is minted from.
 *
 * Re-exported from `step-budget.ts`, the module that owns the row it travels in:
 * a brand declared twice is two unrelated types, and the shape has to be one
 * type across the mint site, the row writer and the validator. A branded string
 * rather than an unconstrained one, because the previous shape was fed to
 * `Number()` on its way into the durable record — where anything that was not a
 * decimal integer became `NaN`.
 */
export type { FixRunId } from "./step-budget.ts";

/** The step's dependencies: the outside world, injected. */
export interface ReviewDeps {
  /** The headless mode this run was started in; its children's permission stamp. */
  headless: boolean;
  exec: ExecFn;
  /** One round of the adversarial gate. Injected so a test drives verdicts with no child. */
  adversarial: (args: AdversarialArgs) => Promise<DispatchResult>;
  /** One round of the six-lens pass. */
  lens: (args: LensArgs) => Promise<LensRound>;
  /**
   * The fixer, in the tree its `cwd` names.
   *
   * `BuildDispatch` rather than a re-declared narrower seam: it is the sibling
   * the same child crosses in `build`, and it already carries `writeFence` —
   * which the review step's fixer needs exactly as the builder does. A seam
   * that cannot carry the fence can only enforce it by not dispatching.
   */
  dispatch: BuildDispatch;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
}

/** The `review` step. Returns `done` or a routed budget verdict; THROWS on anything else. */
export async function reviewOutcome(ctx: HandlerCtx, deps: ReviewDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  const branch = specifyBranch(ctx.run.branch, issue);
  const base = ctx.run.baseSha;
  try {
    assertSafeRef(branch);
    if (base !== "") assertSafeRef(base);
  } catch (err) {
    throw new ReviewInfraError((err as Error).message);
  }
  if (!isFullCommitSha(base))
    throw new ReviewInfraError(
      `the run has no base commit to review against: ${JSON.stringify(base.slice(0, 80))}`,
    );

  // The contract, the config and the issue, all read before any child is paid:
  // a step that discovered its spec was unreadable after two rounds of review
  // had spent those rounds for nothing.
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

  // The step's disposable trees are named once per attempt, so every round of a
  // resumed run re-enters the paths its crashed self left (see `fixRunId`).
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
  // What the budget's turn ceiling is, for the cause line only — the round
  // count never reads it (see `MAX_REVIEW_ROUNDS`).
  const turnCap = budgetFor(config, "review")?.turns ?? 0;

  // `rows` accumulates across the WHOLE step, not one round: the handback must
  // say what every round cost, including the one that failed. Nothing re-derives
  // it per round — a total rebuilt each round reports a two-round run to the
  // operator as a one-round one.
  const rows: DispatchUsageRow[] = [];
  let head = await reviewedHead(deps, repoRoot, branch, rows);
  // This attempt's number, from the log the engine resumes off — see
  // `reviewAttemptFromLog`. It is part of every fix tree's name, so it is read
  // once here rather than derived per round.
  const attempt = reviewAttemptFromLog(ctx.steps);
  /**
   * Findings the adversarial gate passed on without blocking, for the lenses to
   * weigh. Set on the pass-with-findings arm and read on the lens arm — the arm
   * that consumes them is the next round's, because the findings arm fixes first
   * and comes back around, so the assignment must survive the `continue`.
   */
  let carried: string | undefined;
  /**
   * What the LAST fix round was asked to fix, and the head it started from.
   *
   * The tie-breaker the loop otherwise has none of. `MAX_REVIEW_ROUNDS` bounds
   * the fixer, and `assertFixAdvanced` refuses a fixer that fixed nothing — but
   * neither sees the case where the fixer DID land a commit and the gate that
   * asked for it comes back with the identical findings anyway. That is not a
   * reviewer being stubborn, it is a deterministic gate: `adversarialGate` reads
     the head it was handed and re-reports what it saw, and a finding it did not
   * fix (out of scope, or unfisable without touching a frozen test, which the
   * fixer's brief tells it to leave alone) recurs verbatim. Measured: a run whose
   * fixer commits on every round and whose adversarial gate always returns one
   * finding dispatched fixers forever — the round counter incremented, the
   * `round >= MAX_REVIEW_ROUNDS` guard lives on the LENS arm only, so nothing
   * bounded the adversarial arm at all.
   *
   * So: if a fix round moved the head and the SAME gate then reported the SAME
   * findings against the new head, the loop is not making progress and the next
   * round will not either. Hand back with the findings, rather than buying them.
   */
  let lastFix: { gate: string; findings: string; from: string } | undefined;

  try {
    for (let round = 1; ; round++) {
      const gate = await adversarialGate(deps, ctx, {
        base,
        head,
        branch,
        issueBody,
        round,
        rows,
        budget,
      });
      // The operator's ceiling stopping this step is a VERDICT, not a verdict on
      // the work — read before the gate's own infra throw could mistake a
      // stopped reviewer for "no verdict at all".
      if (gate.stop !== undefined) return budgetVerdictWithRows(STEP_NAME, gate.stop, rows);

      if (gate.findings !== "") {
        carried = gate.findings;
        const fix = await fixRound(deps, ctx, {
          head,
          frozen,
          findings: gate.findings,
          gate: "adversarial loop",
          round,
          arm: "a",
          attempt,
          runId,
          rows,
          budget,
        });
        if (fix.stop !== undefined) return budgetVerdictWithRows(STEP_NAME, fix.stop, rows);
        // The stagnation check reads what the fix round was asked for, so it is
        // recorded before the head moves: after the move, the round's own request
        // is no longer recoverable and the comparison would be against nothing.
        const requested = {
          gate: "adversarial loop",
          findings: gate.findings,
          from: head,
        };
        head = await assertFixAdvanced(head, fix.head, rows);
        // Same gate, same findings, a head that moved: the fixer answered the
        // round and the gate did not move. One more round buys the same reply.
        if (stagnantAgainstFix(lastFix, requested, head))
          throw new ReviewInfraError(
            `the adversarial loop reported the same findings again after the fix round moved the head to ${head.slice(0, 12)} — a deterministic gate re-reporting what it already saw is not progress, and the findings are: ${gate.findings.slice(0, 500)}`,
            rows,
          );
        lastFix = requested;
        continue;
      }

      const lens = await lensGate(deps, ctx, {
        base,
        branch,
        round,
        pr,
        carried,
        rows,
        budget,
      });
      // "A gate that did not run is never a gate that passed", enforced on the
      // lens round itself rather than only on the adversarial one: the review
      // layer reports an empty-delta round as `verdict: "APPROVED"` with no lens
      // behind it (its own docs say every consumer must branch on `noReview`),
      // and a round whose lenses all died reports no usage at all. Either one
      // reaching `done` would tell the operator the head was reviewed when the
      // step paid for nobody to look at it.
      if (lens.noReview === true)
        throw new ReviewInfraError(
          `the six-lens review ran no lens (nothing changed since the last recorded run${
            lens.note === undefined ? "" : `: ${lens.note}`
          }) — a head nobody re-reviewed is not a pass`,
          rows,
        );
      if (lens.usage === undefined)
        throw new ReviewInfraError(
          `the six-lens review reported ${lens.verdict} with no usage from any lens child — that is not a pass: ${lens.findings.slice(0, 300)}`,
          rows,
        );
      if (lens.verdict === "APPROVED") {
        // The note a cleared round still owes. `finishLensReview` sets it ONLY on
        // an ISSUES_FOUND round whose disclosure post failed or could not be
        // attempted, so it cannot arrive on this verdict — but "cannot happen" is
        // not a reason to drop it, and a note carried into the step and read by
        // nothing is the silent version of the failure it reports. The merge
        // guard's round-cap path refuses a merge until the marker carrying these
        // findings is on the PR (condition 5, `merge-guard-round-cap.ts`), so a
        // note this step swallowed would cost the run its ability to merge with
        // nobody able to say why. Inlined here rather than kept in a loop-external
        // `disclosure` variable that only ever had this one reader.
        const owed =
          lens.note === undefined || lens.note.trim() === ""
            ? ""
            : `; DISCLOSURE NOT POSTED: ${lens.note}`;
        // The success path is BOUNDED like every other surface that reports rows.
        // `DISPATCHES_MAX_ROWS` is the validator's own cap — `specify` clips its
        // merged rows with it and `error-outcome.ts` clips the throw path, and an
        // unbounded `done` was the one arm that could hand the engine a record the
        // loader then rejects, which does not report an over-long run: it drops
        // the step's cost rows entirely, silently under-billing the child that
        // costs the most.
        return {
          kind: "done",
          reason: `adversarial and six-lens review clean at ${lens.head.slice(0, 12)} (${String(round)} round(s))${owed}`,
          dispatches: rows.slice(-DISPATCHES_MAX_ROWS),
        };
      }
      if (NO_FIX_VERDICTS.includes(lens.verdict))
        throw new ReviewInfraError(
          `the six-lens review did not complete (${lens.verdict}${lens.note === undefined ? "" : `; disclosure: ${lens.note}`}) — an incomplete round is not a pass to fix against`,
          rows,
        );
      if (round >= MAX_REVIEW_ROUNDS)
        throw new ReviewInfraError(
          `findings still open after ${String(round)} review round(s) at the step's bound of ${String(MAX_REVIEW_ROUNDS)} rounds / ${String(turnCap)} turns: ${lens.findings.slice(0, 500)}`,
          rows,
        );
      const fix = await fixRound(deps, ctx, {
        head: lens.head,
        frozen,
        findings: lens.findings,
        gate: `six-lens review (${lens.verdict})`,
        round,
        arm: "l",
        attempt,
        runId,
        rows,
        budget,
      });
      if (fix.stop !== undefined) return budgetVerdictWithRows(STEP_NAME, fix.stop, rows);
      const lensRequested = {
        gate: `six-lens review (${lens.verdict})`,
        findings: lens.findings,
        from: lens.head,
      };
      head = await assertFixAdvanced(lens.head, fix.head, rows);
      if (stagnantAgainstFix(lastFix, lensRequested, head))
        throw new ReviewInfraError(
          `the six-lens review reported the same findings again after the fix round moved the head to ${head.slice(0, 12)} — the findings are: ${lens.findings.slice(0, 500)}`,
          rows,
        );
      lastFix = lensRequested;
    }
  } finally {
    await closeFixTrees(deps, ctx);
  }
}
