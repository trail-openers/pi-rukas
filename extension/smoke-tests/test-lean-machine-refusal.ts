#!/usr/bin/env bun
/**
 * lean/machine — who may reach the refusal, and who may not.
 *
 * Split from `test-lean-machine.ts` for the 500-line gate (AGENTS.md §12). The
 * sibling file pins single transitions; this one pins two properties of the
 * whole graph, which need a walk over every counter combination rather than a
 * table.
 *
 * The `decline` / `not-ready` split exists because one state was both the
 * report and the verdict, and the engine grew special cases to tell them apart.
 * These two assertions are what keeps the split from rotting back:
 *
 *   - `decline` is reachable from EXACTLY two edges — `ready + fail` and
 *     `specify + no-red-test`. A third state routing there would report a
 *     refusal the table never judged; either of those two losing its edge
 *     would send a refusal to the forge never having been named.
 *   - nothing but `decline` routes to `not-ready`. A direct edge would end a
 *     run at exit 11 with no comment on the issue, which is the exact bug the
 *     dual-role state produced and the reason the terminal state now has no
 *     handler at all.
 *
 * Both are enumerated over every declared (state, kind) pair AND every counter
 * combination, because the loop guards are where a misroute hides: at the
 * default counters a `build + ok` never reaches the cap, and a cap that is one
 * comparison off looks correct in every single-transition test.
 */

import { next, outcomeKindsFor } from "../src/lean/machine.ts";
import { INITIAL_COUNTERS, type LeanRun, type LeanState } from "../src/lean/state.ts";
import { DECLINE_SOURCES, NON_TERMINAL_STATES, counterVariants } from "./lib/lean-machine-edges.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function run(state: LeanState, over: Partial<LeanRun> = {}): LeanRun {
  return {
    schema: 1,
    issue: 1,
    version: "test",
    models: {},
    baseSha: "sha",
    branch: "b",
    state,
    counters: { ...INITIAL_COUNTERS },
    steps: [],
    ...over,
  };
}

const toDecline: string[] = [];
const toNotReadyDirect: string[] = [];
let walks = 0;

for (const state of NON_TERMINAL_STATES) {
  for (const kind of outcomeKindsFor(state)) {
    for (const counters of counterVariants()) {
      walks++;
      let moved: { state: LeanState } | undefined;
      try {
        moved = next(run(state, { counters: { ...INITIAL_COUNTERS, ...counters } as never }), {
          kind,
        });
      } catch {
        continue;
      }
      const pair = `${state}+${kind}`;
      // The state the table routes FROM, never the one it routes TO: recording
      // the destination would make this list say "which states can reach
      // decline", and a run that reaches it from a counter combination the
      // fixture forgot would then match a pair already in it.
      if (moved.state === "decline" && !toDecline.includes(pair)) toDecline.push(pair);
      // `decline`'s own two edges are the report carrying the run to its
      // verdict — that is the design, not a bypass. What must not exist is a
      // state that skips the report and ends the run at 11 itself, so the
      // reporting state is excluded from the direct-arrival list by name.
      if (moved.state === "not-ready" && state !== "decline" && !toNotReadyDirect.includes(pair))
        toNotReadyDirect.push(pair);
    }
  }
}

assert(walks > 100, `the walk crossed pairs with counters (${walks} combinations tried)`);
assert(
  toDecline.length === DECLINE_SOURCES.size &&
    [...DECLINE_SOURCES].every((pair) => toDecline.includes(pair)),
  `decline is reachable only from ready + fail and specify + no-red-test (found: ${
    toDecline.join(", ") || "nothing"
  })`,
);
assert(
  toNotReadyDirect.length === 0,
  `nothing routes to not-ready directly — every refusal is reported first (found: ${
    toNotReadyDirect.join(", ") || "none"
  })`,
);

process.exit(exit);
