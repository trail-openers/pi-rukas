/**
 * lean/review-args — what the `review` step hands one round of each gate, and
 * what one six-lens round answered back.
 *
 * Split from `review.ts` for the 500-line cap (AGENTS.md §12). The seam is
 * direction: `review.ts` is the decision procedure, and these three shapes are
 * the boundary between it and the two frozen review layers its `ReviewDeps`
 * seams call. The loop's judgement and the argument shapes of the calls it makes
 * change for different reasons — a new lens-side knob touches this file and the
 * adapter, not the loop — so they are not stored in the same module.
 *
 * One rule the shapes carry that is easy to lose when they move: `LensRound`'s
 * review-layer fields are a `Pick<>` of the layer's own summary type rather than a
 * hand-restated copy, so the compiler refuses this file the moment the layer
 * renames or retypes one of them — which is exactly when a hand-written copy
 * would have quietly kept reading `undefined`.
 */

import type { LensReviewSummary } from "../lens-review-format.ts";
import type { Finding, LensRunResult } from "../lens-review-types.ts";
import type { BudgetArms } from "./step-budget.ts";

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
