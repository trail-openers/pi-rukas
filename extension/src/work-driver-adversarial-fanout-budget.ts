/**
 * work-driver-adversarial-fanout-budget — the per-workstream retry ladder's
 * budget, and the two ways the fan-out publishes it (#486 / #1863). Split from
 * work-driver-adversarial-fanout.ts for the AGENTS.md §12 500-line gate.
 * Leaf module: pure, no dependency on any work-driver-<step>.ts handler.
 *
 * The budget is `pipelineState.adversarialTransientRetries`, and it has two
 * consumers that must never disagree:
 *
 *  - the fan-out's OWN candidate filter, which reads it at pass start to seed
 *    `localRetries` — so a cycle that re-enters the step (crash-resume, or the
 *    step-level RETRY_ONCE) cannot run a whole fresh ladder on top of the one
 *    it already spent;
 *  - every retry branch of the step router, which `persistCycle`s the state it
 *    was handed.
 *
 * #1863 — the second consumer is why these are exported functions rather than
 * inline object spreads. The ladder's spend used to reach only the state the
 * retry branches persist; the state the fan-out RETURNED on the paths that
 * leave without a retry — the N=1 first pass, which hands a `dispatch-failed`
 * tail to the step-level RETRY_ONCE — carried none of it. The re-entry therefore
 * seeded an empty budget and ran a second full ladder (#357 T8 measured 6
 * `adversarialLoopFn` calls where the contract says 4). Both publishers now go
 * through here, and both MERGE rather than replace: a map that replaced the
 * prior one could drop a sibling workstream's count and re-arm its ladder.
 */

import type { PipelineState } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

/** The budget entries this pass spent, merged over whatever the state carries. */
export function mergeLadderBudget(
  prior: PipelineState["adversarialTransientRetries"],
  spent: Readonly<Record<string, number>>,
): Record<string, number> {
  return { ...prior, ...spent };
}

/**
 * Publish the fan-out's spent ladder onto the state it returns, so the
 * RETRY_ONCE re-entry seeds `localRetries` from the attempts already paid for.
 */
export function withSpentLadderBudget(
  state: WorkState,
  spent: Readonly<Record<string, number>>,
): WorkState {
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      adversarialTransientRetries: mergeLadderBudget(
        state.pipelineState.adversarialTransientRetries,
        spent,
      ),
    },
  };
}
