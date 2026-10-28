/**
 * lean/transitions — the counter arithmetic behind every edge in the table.
 *
 * Split from `machine.ts` for the brief's 250-line cap. The table itself stays
 * one function in one file — that is the thing a reader has to hold in their
 * head — but how a transition computes the next counters is a separate
 * concern, and the two rules worth reading carefully are here:
 *
 *   - `viaBuild` spends exactly one build attempt. `build` is the only state
 *     that consumes an attempt, so the helper that enters build is the only
 *     place that number moves, and "did this edge bill a round" is answerable
 *     by looking for a `viaBuild` call.
 *   - the `draft` marker is a THREE-way parameter, not a boolean. `undefined`
 *     passes the run's current value through untouched — which is what lets a
 *     CI fix round re-enter build without clearing the red a verify step
 *     recorded. `true` and `false` set it. A boolean would have collapsed
 *     "do not opine" into "clear it", and that is the difference between a
 *     run that can still merge after a fix round and one that silently loses
 *     the fact that its gate said red.
 */

import type { LeanRun, LeanState, RunCounters } from "./state.ts";

export interface Transition {
  state: LeanState;
  counters: RunCounters;
}

/** `build` is the only state that consumes an attempt, and this is the only way in. */
export function viaBuild(
  run: LeanRun,
  state: LeanState,
  draft?: boolean,
  patch: Partial<RunCounters> = {},
): Transition {
  return {
    state,
    counters: {
      ...run.counters,
      buildAttempts: run.counters.buildAttempts + 1,
      // `undefined` is a pass-through: the transition does not opine on the
      // marker, so a CI fix round re-enters build without clearing the red a
      // verify step set. `patch` is applied last so a transition that sets
      // both a marker and a flag stays consistent, rather than having one
      // silently overwrite the other.
      ...(draft === undefined ? {} : { draft }),
      ...patch,
    },
  };
}

/** Every other state passes the counters through unchanged unless it says so. */
export function to(run: LeanRun, state: LeanState, patch: Partial<RunCounters> = {}): Transition {
  return { state, counters: { ...run.counters, ...patch } };
}
