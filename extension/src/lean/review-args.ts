/**
 * lean/review-args — what the `review` step hands one round of each gate, what
 * one six-lens round answered back, and what the step needs from the outside
 * world to decide anything.
 *
 * Split from `review.ts` for the 500-line cap (AGENTS.md §12). The seam is
 * direction: `review.ts` is the decision procedure, and these shapes are the
 * boundary between it and the two frozen review layers its `ReviewDeps` seams
 * call. The loop's judgement and the argument shapes of the calls it makes
 * change for different reasons — a new lens-side knob touches this file and the
 * adapter, not the loop — so they are not stored in the same module. They are
 * also the shapes every sibling that participates in a round compiles against
 * (`review-gates.ts` calls the gates, `review-deps.ts` builds the deps,
 * `review-git.ts` and `review-tree.ts` take the deps to move bytes, and the
 * smoke fixtures drive the step through them), so the contract and the
 * algorithm are different things and this is the file the rest of the step
 * reads.
 *
 * Three rules live here rather than in a comment on a call site, because they
 * are the rules a caller can break silently and the compiler cannot catch:
 *
 * **`LensRound`'s review-layer fields are a `Pick<>` of the layer's own summary
 * type rather than a hand-restated copy,** so the compiler refuses this file the
 * moment the layer renames or retypes one of them — which is exactly when a
 * hand-written copy would have quietly kept reading `undefined`.
 *
 * **The bar the round is judged against is an argument, not a default.**
 * `LensArgs.threshold` carries the severity at which a finding blocks the run.
 * A round that arrives without one is judged at the review layer's MEDIUM
 * default, which is looser than what a project that states a bar in its
 * doctrine asked for — and the difference is invisible in the verdict, because
 * both answer "APPROVED"/"ISSUES_FOUND". That is how the project's own sentence
 * went unapplied on two of the three review paths.
 *
 * **The bar is resolved once per step, never per round.** See
 * `ReviewDeps.reviewThreshold` for why a per-round read is both wasteful and
 * wrong.
 */

import type { LensReviewSummary, Severity } from "../lens-review-format.ts";
import type { Finding, LensRunResult } from "../lens-review-types.ts";
import type { runLensReview } from "../lens-review.ts";
import type { DispatchResult } from "../types.ts";
import type { ExecFn } from "../worktree.ts";
import type { BuildDispatch } from "./build-types.ts";
import type { WorkConfig } from "./config.ts";
import type { BudgetArms, FixRunId } from "./step-budget.ts";

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
export type { FixRunId };

/**
 * What one six-lens round answered, as the step reads it.
 *
 * `verdict`/`usage`/`note`/`noReview` are the review layer's own summary fields
 * rather than a hand-restated copy: `Pick<LensReviewSummary, ...>` means the
 * compiler refuses this type the moment the layer renames or retypes one of
 * them, which is exactly when a hand-written copy would have quietly kept
 * reading `undefined`.
 */
export type LensRound = Pick<
  LensReviewSummary,
  "verdict" | "usage" | "note" | "noReview" | "deltaReview"
> & {
  /** The round's findings as the text a fixer is handed — one line each. */
  findings: string;
  /**
   * One record per lens child that ran, for the step's cost rows (see
   * `lensRows`). Carried rather than folded here because the fold lives with
   * the other cost rows in `step-budget.ts`, next to `dispatchUsageRow`.
   */
  lenses: LensRunResult[];
  /**
   * The blocking rows this round REPORTED, structured rather than as the one
   * rendered string above.
   *
   * The step reads identities, not prose: each row's fate is already the review
   * layer's own verdict on it — `reported` is the BLOCKING half, post-advisory-split,
   * and a row carrying `carried: true` is one `rowFate` REFUSED to resolve, which is
   * the layer's statement that the fix did not answer it. So this is the only row
   * record the step reads: it states no fate of its own about any row (a second fate
   * rule beside the layer's is a second source of truth, and each of its rules drifts
   * separately), and it never invents a per-finding reply protocol.
   */
  reported: Finding[];
  /**
   * The rows `splitAdvisory` moved OUT of `reported` (#1140/#1125): every finding
   * whose cited line sits outside the PR's changed lines, fresh or carried.
   *
   * Carried for one reading and one only: the NOT ADDRESSED check must not be
   * satisfiable by the discount. An advisory row is excluded from the verdict, the
   * severity counts and the ledger's `hasCritical`, so a CARRIED HIGH that the split
   * moved here would clear a fix wave while the layer still holds the row open and
   * prints it under its carried heading — the step would call that round clean.
   * The step therefore reads `isCarried && atOrAboveBar` over `reported` AND
   * these rows. It states no rule of its own about the advisory tier otherwise:
   * a fresh advisory row is the layer's to disclose, exactly as an advisory row is
   * not the step's to block on.
   */
  advisory: Finding[];
};

/**
 * Which half of the step's ONE wave a gate call belongs to.
 *
 * `full` is the whole-branch review; `fix` is the re-review whose range the step
 * bounded to the fix wave's commits. Both gates take it, and it is what the
 * briefs print: the reviewer and the lenses are told which pass they are on in
 * words, because there is no round counter left to put a number in front of.
 */
export type ReviewWave = "full" | "fix";

/** What the step hands one pass of the adversarial gate. */
export interface AdversarialArgs {
  base: string;
  head: string;
  branch: string;
  cwd: string;
  issue: number;
  issueBody: string;
  wave: ReviewWave;
  /**
   * The findings the fix range was allowed to contain, for the `fix` wave only.
   * Threaded to the reviewer's brief so a CRITICAL it raises on bytes the fix
   * did not touch is not mistaken for one the fix introduced.
   */
  blockingFindings?: string;
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
  wave: ReviewWave;
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
  /**
   * The run's issue body, threaded to the lens pass so every lens judges the
   * diff against the ticket rather than against generic best practice. Printed
   * by `lensContext`, which disarms it at the print site; the step reads it once
   * and hands the same text to both passes and to the fixer.
   */
  issueBody: string;
  /**
   * The base of the range this round reviews, when the round is the re-review.
   *
   * The head the fix wave STARTED from — read from what the fix round returned,
   * never re-read from origin. It goes to the review layer as its explicit
   * `since`, so the re-review's diff is `git diff <preFixHead>..<fixed head>`:
   * the lenses read the fix and nothing else. Without it the layer resolves its
   * own automatic delta base, which is the head of the LAST RECORDED RUN rather
   * than the head this step's fixer moved, and a re-review whose range the layer
   * picked is a re-review of something other than the fix.
   */
  since?: string;
  /** Post-change prose and the deterministic claim scan, read from the branch ref. */
  evidence: string | undefined;
  /**
   * The severity at which a finding blocks this run, resolved ONCE per review
   * step at the run's base commit (see `ReviewDeps.reviewThreshold`). Optional
   * only so a test that drives the step with a stub lens need not supply one:
   * the wiring passes it straight to `runLensReview`, and a round with no
   * threshold is judged at the review layer's MEDIUM default — looser than what
   * a project that states a bar in its doctrine asked for.
   */
  threshold?: Severity;
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
  /**
   * The project's blocking severity, read at the run's base commit — one call
   * per review step, never per round.
   *
   * The bar is a property of the project, so asking it once per round would pay a
   * judge child per round to return the same answer, and — worse — let two rounds
   * of one step be judged against two different bars if doctrine changed between
   * them. The step resolves it once and threads it to every lens round, which is
   * also what makes the ledger's `passed` agree with the verdict: both are
   * computed under the value this returned.
   *
   * Injected rather than called inside the wiring for the same reason every other
   * outside world here is: a test of THE THRESHOLD has to observe the value the
   * lens call received, and the step has to be drivable without a judge child.
   */
  reviewThreshold: (repoRoot: string, baseSha: string) => Promise<Severity>;
  /**
   * The six-lens engine, defaulting to `runLensReview` in the wiring.
   *
   * One reason only, and it is a test reason: the clamp that keeps
   * `PI_ENSEMBLE_LENS_BOUND_MS` from being overwritten by the budget arms can only
   * be asserted on the options the lens call ACTUALLY received. An assertion on the
   * input passed the bug — the input was correct in that bug, and only what reached
   * `runLensReview` was wrong. Production never sets this.
   */
  lensEngine?: typeof runLensReview;
  /**
   * The per-lens child runner, threaded to `runLensReview` as its `lensChildFn`
   * (lens-review.ts). Test-only, for the same reason as `lensEngine` and with the
   * opposite grain: this one lets a test drive the REAL engine — the real diff
   * resolution, delta decision and summary — with only the six model children
   * stubbed. Production never sets it and gets the layer's own `runLensChild`.
   */
  lensChildFn?: typeof import("../lens-review-child.ts").runLensChild;
}
