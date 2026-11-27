/**
 * lean/transitions — the counter arithmetic behind every edge in the table.
 *
 * Apart from `machine.ts` so the table stays one function in one file. The two rules worth reading
 * carefully:
 *
 *   - `viaBuild` spends exactly one build attempt, and an attempt is a round DISPATCHED: only an edge whose
 *     destination is `build` may call it. An edge LEAVING build bills nothing, except `build + exhausted`,
 *     the one edge that leaves build and bills: it routes on the run's own gate, a decided green publishing
 *     a draft and anything else handing back, with the round spent either way.
 *   - the `draft` marker is a THREE-way parameter, not a boolean. `undefined` passes the run's current
 *     value through — what lets a CI fix round re-enter build without clearing the red a verify step
 *     recorded. A boolean would collapse "do not opine" into "clear it".
 */
import type { LeanRun, LeanState, RunCounters } from "./state.ts";

export interface Transition {
  state: LeanState;
  counters: RunCounters;
}

/**
 * `build` is the only state that consumes an attempt, and this is the only way in: an edge
 * LEAVING build routes with `to()` instead.
 */
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
      // `undefined` is a pass-through: the transition does not opine on the marker. `patch` is applied
      // last so a transition that sets both a marker and a flag stays consistent.
      ...(draft === undefined ? {} : { draft }),
      ...patch,
    },
  };
}

/** Every other state passes the counters through unchanged unless it says so. */
export function to(run: LeanRun, state: LeanState, patch: Partial<RunCounters> = {}): Transition {
  return { state, counters: { ...run.counters, ...patch } };
}
