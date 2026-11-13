/**
 * lean/review-args — what the `review` step hands one round of each gate, what
 * one six-lens round answered back, and what the step needs from the outside
 * world to decide anything.
 *
 * Split from `review.ts` for the 500-line cap: the loop's judgement and the
 * argument shapes of the calls it make change for different reasons, and every
 * sibling that participates in a round compiles against these shapes.
 *
 * Three rules live here rather than on a call site, because a caller can break
 * each silently and the compiler cannot catch it: `LensRound`'s review-layer
 * fields are a `Pick<>` of the layer's own summary type so a rename fails the
 * build instead of reading `undefined`; `LensArgs.threshold` carries the
 * blocking bar as an argument, since a round judged at the layer's HIGH default
 * is looser than what a project that states a bar in its doctrine asked for,
 * and the verdict text does not distinguish the two; and the bar is resolved
 * once per step, never per round (see `ReviewDeps.reviewThreshold`).
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
 * Branded, so the mint site, the row writer and the validator cannot each
 * invent an unconstrained number that reaches `Number()` as `NaN`.
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
  /** One record per lens child that ran; the fold into cost rows lives in `step-budget.ts`. */
  lenses: LensRunResult[];
  /**
   * The blocking rows this round REPORTED, structured rather than as the rendered
   * string above. The step reads identities, not prose, and states no fate of its
   * own: a second fate rule beside the layer's is a second source of truth.
   */
  reported: Finding[];
  /**
   * The rows `splitAdvisory` moved OUT of `reported`: findings whose cited line
   * sits outside the PR's changed lines, fresh or carried.
   *
   * Carried for one reading only: the NOT ADDRESSED check must not be satisfiable
   * by the discount, so the step reads `isCarried && atOrAboveBar` over `reported`
   * AND these rows. Otherwise the advisory tier stays the layer's to disclose.
   */
  advisory: Finding[];
};

/**
 * Which half of the step's ONE wave a gate call belongs to.
 *
 * `full` is the whole-branch review; `fix` is the re-review bounded to the fix
 * wave's commits. Both gates take it and the briefs print it, since there is no
 * round counter left to put a number in front of.
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
  /**
   * The issue's acceptance criteria for the reviewer's own section, rendered by the
   * spec split (`lean/review-criteria.ts`) at the seam. Set only by lean's review
   * step; absent means the loop prints no section, which is what keeps classic /work
   * and the `adversarial_loop` tool byte-identical.
   */
  reviewCriteria?: string;
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
   * The run's PR number, when this run opened one. Without it the review layer
   * pays a `gh pr list` per ISSUES_FOUND round for an answer this run already
   * holds, and keys its disclosure on whatever that lookup picked.
   */
  pr: number | undefined;
  /** The context lines this step composes (see `lensContext` in `review-deps.ts`).
   * The run's issue reaches the lenses inside it: `lensContext` prints the
   * fenced block there, so the arg shape carries no separate body. */
  context: string;
  /**
   * The base of the re-review's range: the head the fix wave STARTED from, read
   * from what the fix round returned, never re-read from origin. Without it the
   * layer resolves its own delta base — the head of the LAST RECORDED RUN, not
   * the head this step's fixer moved — and reviews something other than the fix.
   */
  since?: string;
  /** The re-review of a carried CRITICAL is bought whole-branch: the layer's own
   * opt-out from its automatic delta base, which a missing `since` alone would not
   * suppress. Never set on the delta arm. */
  full?: boolean;
  /** Post-change prose and the deterministic claim scan, read from the branch ref. */
  evidence: string | undefined;
  /**
   * The severity at which a finding blocks this run, resolved ONCE per review
   * step at the run's base commit. Optional only so a stub-lens test need not
   * supply one; a round with no threshold falls to the layer's HIGH default.
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
   * per review step, never per round: a per-round read pays a judge child for
   * the same answer and lets two rounds of one step be judged against different
   * bars. Resolving once is also what makes the ledger's `passed` agree with the
   * verdict. Injected so a test can observe the value the lens call received.
   */
  reviewThreshold: (repoRoot: string, baseSha: string) => Promise<Severity>;
  /** Post one comment on the run's PR: the disclosure of lanes the step never
   * judged, which only this step can put in front of a human because `publish`
   * runs BEFORE `review`, so the PR body cannot carry it. Injected like every
   * other outside world here, so a case can observe the text that reached the
   * forge. Absent means no disclosure surface; the step still logs and records. */
  prComment?: (repoRoot: string, prNumber: number, body: string) => Promise<void>;
  /**
   * The six-lens engine, defaulting to `runLensReview` in the wiring. Test-only:
   * the clamp on `PI_ENSEMBLE_LENS_BOUND_MS` can only be asserted on the options
   * the call ACTUALLY received — asserting the input passes a bug where only the
   * forwarded options were wrong. Production never sets this.
   */
  lensEngine?: typeof runLensReview;
  /**
   * The per-lens child runner, threaded to `runLensReview` as its `lensChildFn`.
   * Test-only, opposite grain to `lensEngine`: drives the REAL engine with only
   * the six model children stubbed. Production gets the layer's own `runLensChild`.
   */
  lensChildFn?: typeof import("../lens-review-child.ts").runLensChild;
}
