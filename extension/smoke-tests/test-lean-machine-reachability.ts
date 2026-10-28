#!/usr/bin/env bun
/**
 * lean/machine — reachability: an unresolved red verify never reaches `land`.
 *
 * Split from `test-lean-machine.ts` for the 500-line gate (AGENTS.md §12). The
 * sibling file pins single transitions; this one pins a property of the whole
 * graph, which is a different kind of claim and needs a walker rather than a
 * table.
 *
 * The claim is about a path, not a transition. A red verify MAY legitimately
 * re-green later — that is what a fix round is for — and the run that recovers
 * is allowed to land. What it is not allowed to do is arrive at `land` while
 * its own record still says the work was not verified. `land` is reachable
 * from a red verify by design; blocking that would block every run that fixes
 * its own red.
 *
 * Two things make the walk an argument about the table rather than about
 * itself, and both are load-bearing:
 *
 *   - The outstanding claim is read from the run's OWN `draft` counter as the
 *     table sets and clears it. The walk tracks no verdict of its own, so if
 *     the marker ever stops meaning "my gate said red", this goes red.
 *   - Each walk starts from a counter combination produced by the table, and
 *     `draft` is never seeded true — seeding it would assert "a run that
 *     starts in breach ends in breach", a tautology that passes whatever the
 *     table does.
 *
 * It also mirrors the engine's own step rule: entering a state a second time
 * runs its handler again, so a second entry's outcome must be a fresh one.
 * That is the `entries` bound below, and it is the same rule
 * `engine.ts` enforces by keying steps on the entry count.
 */

import { MAX_BUILD_ATTEMPTS, type Transition, next, outcomeKindsFor } from "../src/lean/machine.ts";
import { INITIAL_COUNTERS, type LeanRun, type LeanState, isTerminal } from "../src/lean/state.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The counters a walk step is started from. `RunCounters` has no index
 * signature, so the walker widens it on the way in and the table narrows it
 * back on the way out; the fields are the same five, and `next()` is what
 * guarantees it never invents a sixth. */
type Counters = Record<string, unknown>;

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

const VERIFY_COUNTERS: Counters[] = [];
for (const buildAttempts of [0, 1, MAX_BUILD_ATTEMPTS]) {
  for (const challengeDone of [false, true]) {
    for (const reviewDone of [false, true]) {
      for (const ciFixUsed of [false, true]) {
        VERIFY_COUNTERS.push({ buildAttempts, challengeDone, reviewDone, ciFixUsed, draft: false });
      }
    }
  }
}

const reachedLand: string[] = [];

/**
 * Explore one run forward, refusing any arrival at `land` that carries an
 * unresolved claim.
 *
 * `land` is stepped up to but never into: `land + merged` is what actually
 * merges, and the claim under test is that an unresolved run never gets the
 * chance to try. `depth` and `entries` are the two bounds that make this
 * finite — every cycle in the table passes through a gate whose handler
 * re-runs, so two entries per state is enough to exhaust the graph.
 */
function walk(
  state: LeanState,
  counters: Counters,
  path: string[],
  depth: number,
  entries: Record<string, number>,
): void {
  if (isTerminal(state) || depth > 10) return;
  for (const kind of outcomeKindsFor(state)) {
    if ((entries[state] ?? 0) >= 2) return;
    let moved: Transition;
    try {
      moved = next(run(state, { counters: counters as never }), { kind });
    } catch {
      continue;
    }
    const step = `${state}+${kind}`;
    // The run's `draft` marker IS the outstanding claim: the table sets it
    // when its gate says red or runs out of rounds, and clears it only on a
    // green verify — the one verdict that re-reads the criteria after a fix.
    // `build + ok` is a model claiming it implemented the spec and
    // `ci + green` is a pipeline running whatever the repo named; neither
    // clears anything, which is exactly the hole this walk found.
    if (moved.state === "land") {
      if (moved.counters.draft) reachedLand.push([...path, step].join(" → "));
      continue;
    }
    walk(moved.state, moved.counters as unknown as Counters, [...path, step], depth + 1, {
      ...entries,
      [moved.state]: (entries[moved.state] ?? 0) + 1,
    });
  }
}

for (const counters of VERIFY_COUNTERS) {
  const after = next(run("verify", { counters: counters as never }), { kind: "red" });
  walk(after.state, after.counters as unknown as Counters, ["verify+red"], 0, { verify: 1 });
}

assert(
  reachedLand.length === 0,
  `no path from an unresolved red verify reaches land (${VERIFY_COUNTERS.length} counter states explored; offenders: ${
    reachedLand.slice(0, 3).join(" | ") || "none"
  })`,
);

// The walk is not vacuous: a run that resolves its red DOES reach land, so a
// table that blocked every red-then-green recovery would fail above and pass
// here only by accident. Assert the positive direction explicitly.
const recovered = next(run("verify", { counters: { ...INITIAL_COUNTERS, draft: true } }), {
  kind: "green",
});
assert(
  recovered.state === "publish" && recovered.counters.draft === false,
  "a green verify clears the red, so recovery stays possible",
);

/** Every (state, kind) pair the table has, following the engine's entry rule. */
function reachableToLandFrom(
  state: LeanState,
  counters: Counters,
  entries: Record<string, number>,
  depth = 0,
): boolean {
  if (isTerminal(state) || depth > 10) return false;
  for (const kind of outcomeKindsFor(state)) {
    if ((entries[state] ?? 0) >= 2) return false;
    let moved: Transition;
    try {
      moved = next(run(state, { counters: counters as never }), { kind });
    } catch {
      continue;
    }
    if (moved.state === "land") return true;
    if (
      reachableToLandFrom(
        moved.state,
        moved.counters as unknown as Counters,
        {
          ...entries,
          [moved.state]: (entries[moved.state] ?? 0) + 1,
        },
        depth + 1,
      )
    )
      return true;
  }
  return false;
}

assert(
  reachableToLandFrom("verify", { ...INITIAL_COUNTERS } as unknown as Counters, { verify: 0 }),
  "a green-from-the-start verify still reaches land — the walk above is a filter, not a wall",
);

process.exit(exit);
