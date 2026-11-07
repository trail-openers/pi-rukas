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
 * The log is not typed — it is WALKED. `walkLog` drives `next()` over the list
 * of verdicts the steps returned and writes, for each, the entry a drive writes:
 * the state the walk stands in and the `stepKey` the engine would give it. An
 * array hand-typed from the table is a guess about that walk, and this file's
 * guess had been wrong in exactly the way that matters: the entry after
 * `build + ok` on a run not yet challenged is a `challenge` entry, and a list
 * that called it `build` was refused by the fold as a forgery while the case was
 * about a different forgery entirely. Walking makes the label impossible to get
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
  stepKey,
} from "../../src/lean/state.ts";
import { CLOCK } from "./lean-engine-fixtures.ts";

/** A walk position: where the table stands, and what it owes when it gets there. */
interface WalkPos {
  state: LeanState;
  counters: RunCounters;
}

/**
 * The walk to a red CI: the first build, the adversary's round, a RED verify
 * (which raises `draft` and buys the build below it), a green verify, publish,
 * review, and a green CI — then the one CI fix round that green CI did not need,
 * which re-builds, re-verifies, re-publishes, is reviewed again, and meets the
 * SECOND red. That last red is the step the forged snapshot refuses to
 * acknowledge.
 *
 * Each entry is only the verdict the step's handler returned. The state it
 * belongs to is the walk's, not the caller's — which is the whole reason this is
 * a walk: it visits `challenge` three times, because `build + ok` on a run whose
 * challenge round is not done routes there.
 */
// A function, not a module-level array: bun hoists a `const` binding to the top
// of the module body without its initializer, and a `forgedCiRedSteps` defined
// BELOW the list read it as `undefined` at module evaluation time — which is how
// this file's first walk came to report `verify + none` for a list that holds no
// such pair at that position.
function ciRedWalk(): readonly Outcome[] {
  return [
  { kind: "ok" }, // ready
  { kind: "ok" }, // specify
  { kind: "ok" }, // build — the first round
  { kind: "none" }, // challenge — the adversary added nothing
  { kind: "red" }, // verify — raises `draft`, buys the build below
  { kind: "ok" }, // build — the red's fix
  { kind: "none" }, // challenge — the run's one optional round
  { kind: "green" }, // verify
  { kind: "ok" }, // publish
  { kind: "done" }, // review
  { kind: "green" }, // ci — the green that makes the second red the interesting one
  { kind: "ok" }, // build — the CI fix round
  { kind: "none" }, // challenge
  { kind: "green" }, // verify
  { kind: "ok" }, // publish
  { kind: "done" }, // review
  { kind: "red" }, // ci — the step the forged snapshot refuses to acknowledge
  ];
}

/** A bare run — `next()` and `foldLog` read only `state`, `counters` and `issue`. */
function runAt(issue: number, state: LeanState, counters: RunCounters): LeanRun {
  return {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "",
    branch: "",
    state,
    counters,
    steps: [],
  };
}

/**
 * The log a drive would have written for the verdicts in `walk`, entry by entry.
 *
 * Before an entry is written the pair is checked against the table: the state the
 * walk stands in must have an arrow for this verdict, or `walkLog` throws rather
 * record a verdict for a state the run never stood in. `key` is `stepKey` with the
 * count of earlier entries for that state — the engine's own keying, which is why
 * the fold reads this log the way it reads one a drive wrote.
 *
 * The current state is read ONCE per visit, into `at`: a second read of the
 * position inside the loop body saw the visit that has not happened yet, which
 * made the walk refuse a pair the table accepts.
 */
export function walkLog(issue: number, walk: readonly Outcome[]): Step[] {
  const seen: Partial<Record<LeanState, number>> = {};
  let pos: WalkPos = { state: "ready", counters: { ...INITIAL_COUNTERS } };
  const steps: Step[] = [];
  // The position's only reader: a closure that returns the state the PREVIOUS
  // visit's transition produced, so the loop body never reads `pos` itself.
  let nextVisit = (): LeanState => "ready";
  for (const outcome of walk) {
    // The state is taken once per visit and never re-read: this loop is the
    // position, and a second read inside it saw the NEXT visit's state.
    const at = nextVisit();
    if (!hasTransition(at, outcome.kind))
      throw new Error(
        `walkLog: ${at} + ${outcome.kind} is not a step of this walk [so far: ${steps.map((x) => x.key).join(" ")}]`,
      );
    const n = seen[at] ?? 0;
    seen[at] = n + 1;
    steps.push({
      key: stepKey(issue, at, n),
      state: at,
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome,
    });
    const moved = next(runAt(issue, at, pos.counters), outcome);
    pos = { state: moved.state, counters: moved.counters };
    nextVisit = () => moved.state;
  }
  return steps;
}

/** The walk to a red CI, with the snapshot claiming the run still sits at `ci`. */
export function forgedCiRedSteps(issue: number): Step[] {
  return walkLog(issue, ciRedWalk());
}

/**
 * The counters the table reaches on `forgedCiRedSteps`.
 *
 * DERIVED, never typed: this is `foldLog` over the very log above, so a case that
 * refuses this file for its FORGERY (the snapshot claiming `ci` while the newest
 * `ci` row is red) is refused for that and nothing else. A hand-carried literal is
 * a second source of truth for the table's counter arithmetic, and the first thing
 * it does when the billing rule moves is refuse an honest file for the wrong
 * reason.
 *
 * `issue` is a parameter because the fold reads it: entry keys are
 * `<issue>:<state>:<n>`, and folding a log under the wrong issue number makes the
 * fold report a mislabelled entry — the generic "belongs to X but the walk stands
 * at Y" refusal — for a log that is in fact the walk. That is precisely the wrong
 * reason to refuse a file whose whole point is to be refused for one specific
 * forgery.
 */
export function forgedCiRedCounters(issue: number): LeanRun["counters"] {
  return foldLog({
    ...runAt(issue, "ready", { ...INITIAL_COUNTERS }),
    steps: walkLog(issue, ciRedWalk()),
  }).pos.counters;
}
