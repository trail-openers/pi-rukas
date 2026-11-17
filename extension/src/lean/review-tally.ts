/**
 * lean/review-tally — the `review` step's own account of what it judged.
 *
 * Split from `review.ts` for the 500-line gate along the seam the field already
 * drew: `review.ts` is the decision procedure, this is the record it publishes.
 * Both halves — the per-round severity tallies and the heads each fix wave pushed —
 * are step-wide rather than per-pass, because a host asks what the review found IN
 * TOTAL and a second pass that overwrote the first would report a fixed CRITICAL as
 * one the run never saw. `waves` holds only the wave that PUSHED: a first-round
 * clear bought no fixer, and naming a head nobody moved is a stamp the step never
 * earned.
 *
 * The caps are the record's own (`ROUNDS_MAX`/`WAVES_MAX` in
 * `state-outcome-gates.ts`) and the writer clips rather than throws — a gate must not
 * lose its verdict over how many rounds it ran. Read copies are clones, so a host
 * that mutates what it was given cannot reach the running tally.
 */
import type { LensRound } from "./review-args.ts";
import type { ReviewBoundRecord } from "./review-bound.ts";
import {
  ROUNDS_MAX,
  type ReviewRoundCounts,
  WAVES_MAX,
  roundCounts,
} from "./state-outcome-gates.ts";
import type { ReviewRecord } from "./state-outcome-gates.ts";
import type { Outcome } from "./state.ts";

/** The step's fix-wave disclosure, if it has one — folded into the reason by
 * `noteFixDisclosure`, which the step applies before handing the outcome here. */
export interface ReviewTally {
  /** Fold one judged round's rows into the published tally, at the record's own cap. */
  noteRound: (round: LensRound) => void;
  /** Record the head the one fix wave pushed, at the record's own cap. */
  noteWave: (wave: "full" | "fix", pushed: string) => void;
  /** Attach what the step judged to one exit's outcome. Every exit takes it — pass,
   * wave, or stopped mid-wave — so a stopped arm still says what it judged rather than
   * losing the rounds it paid for. With nothing judged the `review` key is absent
   * rather than empty: an empty record would read as a review that ran and saw nothing. */
  attach: (pass: Outcome, extra?: { reviewBound?: ReviewBoundRecord }) => Outcome;
}

/** A fresh tally for one step. One instance per `reviewPass`, like the rows array. */
export function reviewTally(): ReviewTally {
  const rounds: ReviewRoundCounts[] = [];
  const waves: { wave: "full" | "fix"; head: string }[] = [];
  return {
    noteRound: (round) => {
      if (rounds.length < ROUNDS_MAX)
        rounds.push(roundCounts([...round.reported, ...round.advisory]));
    },
    noteWave: (wave, pushed) => {
      if (waves.length < WAVES_MAX) waves.push({ wave, head: pushed });
    },
    attach: (pass, extra = {}) => {
      const review: ReviewRecord | undefined =
        rounds.length === 0 && waves.length === 0
          ? undefined
          : {
              rounds: rounds.map((r) => ({ ...r })),
              waves: waves.map((w) => ({ ...w })),
            };
      return {
        ...pass,
        ...(review === undefined ? {} : { review }),
        ...extra,
      };
    },
  };
}
