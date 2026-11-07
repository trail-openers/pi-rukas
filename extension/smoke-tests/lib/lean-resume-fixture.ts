/**
 * The forgeable log of `test-lean-engine-resume.ts`, in one place.
 *
 * Split from the test for the 500-line cap (AGENTS.md §12) and because the
 * file it writes is the thing four cases judge: a state file whose newest `ci`
 * step is RED while its snapshot claims the run still sits at `ci`. The
 * engine's replay path applies recorded outcomes without running their
 * handlers, so before the fold in `resume.ts` this file resumed by re-applying
 * the older `ci:0 = green` and merged.
 *
 * The log is WALKED, not typed. `forgedCiRedSteps` drives `next()` over the
 * verdicts a drive returns and writes, for each, the entry the engine would
 * have written: the state the walk stands in and the `stepKey` that visit
 * carries. A list hand-typed from the table is a guess about that walk, and
 * this file's guess had been wrong in the way that matters: `build + ok` on a
 * run whose challenge round is not done routes to `challenge`, so a run
 * re-built twice visits `challenge` only ONCE and a list that itemised it twice
 * was refused by the fold as a shape-forgery while the case is about the
 * snapshot forgery described above. Walking makes the label impossible to get
 * wrong, and makes the counters beside it `foldLog`'s own answer — so a file
 * this module writes is refused for its FORGERY and for nothing else.
 */

import { hasTransition, next } from "../../src/lean/machine.ts";
import { foldLog } from "../../src/lean/resume.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  type Outcome,
  type RunCounters,
  type Step,
  nextAttempt,
  stepKey,
} from "../../src/lean/state.ts";
import { CLOCK } from "./lean-engine-fixtures.ts";

/** One step of the walk: the verdict the step's handler returned. */
const o = (kind: Outcome["kind"]): Outcome => ({ kind });

/**
 * The verdicts a run returns on the way to a red SECOND CI.
 *
 * Round one: build, the adversary's round, a RED verify (which raises `draft`
 * and buys the build below it), a green verify, publish, review, and a green
 * CI. Round two: that green CI is what the snapshot's `ci:0` is — the run then
 * took its one CI fix round, re-built, re-published, was reviewed again, and
 * the SECOND CI said red. That last red is the step the forged snapshot
 * refuses to acknowledge.
 *
 * These are ONLY the verdicts. Which state each belongs to is the table's
 * answer, taken by `walkLog` below — which is why this list carries no
 * `challenge` verdict for the CI fix round: the run's challenge round was
 * already done, so `build + ok` routes straight to `verify`.
 */
function ciRedWalk(): readonly Outcome[] {
  return [
    o("ok"), // ready
    o("ok"), // specify
    o("ok"), // build — the first round
    o("none"), // challenge — the adversary added nothing
    o("red"), // verify — RED, which buys the build below it
    o("ok"), // build — the red's fix
    o("green"), // verify — already challenged, so build went here
    o("ok"), // publish
    o("done"), // review
    o("green"), // ci — the green the snapshot clings to
    o("red"), // ci — the SECOND ci visit, red, which buys the CI fix round below
    o("ok"), // build — the CI fix round
    o("green"), // verify
    o("ok"), // publish
    o("done"), // review
    o("red"), // ci — the third ci visit, the second red the snapshot denies
  ];
}

/** A walk position: where the table stands, and what it owes when it gets there. */
interface WalkPos {
  state: LeanState;
  counters: RunCounters;
}

/**
 * Drive the table over `walk` and write the entry a drive writes at each visit.
 *
 * The engine writes an entry for the state it is IN before it asks the handler
 * for a verdict, so the entry's state and key come from `pos`, and `pos` only
 * moves once `next()` has answered. Reading the state back after the move —
 * the mistake this replaces — labels an entry with the state its verdict
 * arrived at, which is a different state and a forgery to the fold.
 */
function walkLog(issue: number, walk: readonly Outcome[]): Step[] {
  const steps: Step[] = [];
  let pos: WalkPos = { state: "ready", counters: { ...INITIAL_COUNTERS } };
  for (const outcome of walk) {
    const at = (message: string): never => {
      throw new Error(`walkLog: ${message} [so far: ${steps.map((s) => s.key).join(" ")}]`);
    };
    if (!hasTransition(pos.state, outcome.kind)) {
      at(`${pos.state} + ${outcome.kind} is not a step of this walk`);
    }
    const visit = pos;
    steps.push(entry(issue, steps, visit, outcome));
    const moved = next(
      { counters: visit.counters, state: visit.state } as LeanRun,
      outcome,
    );
    pos = { state: moved.state, counters: moved.counters };
  }
  return steps;
}

/**
 * The entry a drive writes for the visit `pos` describes.
 *
 * The attempt number is the engine's own `nextAttempt` answer — how many
 * entries THIS WALK already holds for that state — so two `ci` visits carry
 * `ci:0` and `ci:1` the way a real drive's do, and the fold reads the newest
 * row for a state exactly as it does on a log the engine wrote.
 */
function entry(issue: number, soFar: readonly Step[], pos: WalkPos, outcome: Outcome): Step {
  return {
    key: stepKey(issue, pos.state, nextAttempt({ steps: soFar } as LeanRun, pos.state)),
    state: pos.state,
    startedAt: CLOCK,
    endedAt: CLOCK,
    outcome,
  };
}

/**
 * The walk to a red CI, itemised the way a drive itemises it.
 *
 * `issue` is a parameter because entry keys are `<issue>:<state>:<n>` and four
 * cases replay this log under different issue numbers.
 */
export function forgedCiRedSteps(issue: number): Step[] {
  return walkLog(issue, ciRedWalk());
}

/**
 * The counters the table reaches on `forgedCiRedSteps`.
 *
 * DERIVED, never typed: this is `foldLog` over the very log above, so a case
 * that refuses this file for its FORGERY (the snapshot claiming `ci` while the
 * newest `ci` row is red) is refused for that and nothing else. A hand-carried
 * literal is a second source of truth for the table's counter arithmetic, and
 * the first thing it does when the billing rule moves is refuse an honest file
 * for the wrong reason.
 */
export function forgedCiRedCounters(issue: number): LeanRun["counters"] {
  return foldLog({
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "",
    branch: "",
    state: "ready",
    counters: { ...INITIAL_COUNTERS },
    steps: forgedCiRedSteps(issue),
  }).pos.counters;
}
